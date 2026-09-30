import { describe, expect, it } from 'vitest';
import type { HostBridge, HttpRequest, HttpResponse } from '../host/types';
import type { Track } from '../types';
import { LASTFM_API_URL, LastfmClient, md5Hex } from './lastfm';

const API_KEY = 'testapikey';
const API_SECRET = 'testapisecret';

interface StubHost {
  host: HostBridge;
  requests: HttpRequest[];
}

function stubHost(respond: (req: HttpRequest) => string): StubHost {
  const requests: HttpRequest[] = [];
  const store = new Map<string, string>();
  const host = {
    http: {
      request: async (req: HttpRequest): Promise<HttpResponse> => {
        requests.push(req);
        return { status: 200, headers: {}, body: respond(req), fromCache: false };
      },
    },
    kv: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: string) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      keys: async () => [...store.keys()],
    },
  } as unknown as HostBridge;
  return { host, requests };
}

/** The params a signed request actually carried, in the order they were sent. */
function sentParams(req: HttpRequest): Array<[string, string]> {
  const raw = req.method === 'POST'
    ? (req.body ?? '')
    : req.url.slice(req.url.indexOf('?') + 1);
  return [...new URLSearchParams(raw).entries()];
}

function concatPairs(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => k + v).join('');
}

function track(over: Partial<Track> = {}): Track {
  return {
    uri: 'audius:track:1',
    provider: 'audius',
    title: 'Şarkı Söylemek',
    artists: [{ uri: 'audius:artist:1', name: 'Sezen Aksu' }],
    durationMs: 210_000,
    ...over,
  };
}

describe('md5Hex against the RFC 1321 vectors', () => {
  const vectors: Array<[string, string]> = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      'd174ab98d277d9f5a5611c2c9f419d9f',
    ],
    ['1234567890'.repeat(8), '57edf4a22be3c955ac49da2e2107b67a'],
  ];

  for (const [input, expected] of vectors) {
    it(`hashes ${JSON.stringify(input.slice(0, 24))} (${input.length} chars)`, () => {
      expect(md5Hex(input)).toBe(expected);
    });
  }

  it('hashes inputs that straddle the 56-byte padding boundary', () => {
    // 55/56/57 bytes exercise "fits", "needs a whole extra block" and "just over".
    expect(md5Hex('a'.repeat(55))).toBe('ef1772b6dff9a122358552954ad0df65');
    expect(md5Hex('a'.repeat(56))).toBe('3b0c8ac703f828b04c6c197006d17218');
    expect(md5Hex('a'.repeat(57))).toBe('652b906d60af96844ebd21b674f35e93');
  });
});

describe('md5Hex hashes UTF-8 bytes, not UTF-16 code units', () => {
  it('hashes Turkish characters as their UTF-8 encoding', () => {
    expect(md5Hex('Şarkı')).toBe('017d1f8200779148233f5328da1b465b');
    expect(md5Hex('ğüşıöçİĞÜŞÖÇ')).toBe('c71373252e2a37cd7e5b59349e74a8f4');
    expect(md5Hex('Sezen Aksu — Şarkı Söylemek Lazım'))
      .toBe('6707a78d3ad2b3b01692b085d4b721c2');
  });

  it('hashes three-byte and four-byte code points', () => {
    expect(md5Hex('日本語')).toBe('00110af8b4393ef3f72c50be5b332bec');
    // A surrogate pair must be recombined into one code point before encoding.
    expect(md5Hex('😀')).toBe('2a02eac39d716a70ecf37579185927b6');
  });
});

describe('API signature', () => {
  /** `sign` is private to the client; the spec for it is worth pinning directly. */
  function signOf(client: LastfmClient, params: Record<string, string>): string {
    return (client as unknown as { sign(p: Record<string, string>): string }).sign(params);
  }

  it('concatenates key+value in sorted key order and appends the secret', () => {
    const { host } = stubHost(() => '{}');
    const client = new LastfmClient(host, API_KEY, API_SECRET);
    const params = { zeta: 'z', method: 'track.scrobble', alpha: 'a', api_key: API_KEY };

    expect(signOf(client, params)).toBe(
      md5Hex(`alphaaapi_key${API_KEY}methodtrack.scrobblezetaz${API_SECRET}`),
    );
  });

  it('excludes format and callback from the signed payload', () => {
    const { host } = stubHost(() => '{}');
    const client = new LastfmClient(host, API_KEY, API_SECRET);
    const base = { method: 'auth.getToken', api_key: API_KEY };

    const withNoise = signOf(client, { ...base, format: 'json', callback: 'cb' });
    expect(withNoise).toBe(signOf(client, base));
    // Sanity: had they been signed, the digest would have moved.
    expect(withNoise).not.toBe(
      md5Hex(`api_key${API_KEY}callbackcbformatjsonmethodauth.getToken${API_SECRET}`),
    );
  });

  it('signs auth.getToken over the sorted params and sends an unsigned format=json', async () => {
    const { host, requests } = stubHost(() => JSON.stringify({ token: 'tok-1' }));
    const client = new LastfmClient(host, API_KEY, API_SECRET);

    const { token, url } = await client.getAuthUrl();
    expect(token).toBe('tok-1');
    expect(url).toContain('token=tok-1');

    const req = requests[0]!;
    expect(req.url.startsWith(`${LASTFM_API_URL}?`)).toBe(true);

    const pairs = sentParams(req);
    const sig = pairs.find(([k]) => k === 'api_sig')?.[1];
    expect(pairs.find(([k]) => k === 'format')?.[1]).toBe('json');
    expect(sig).toBe(
      md5Hex(`api_key${API_KEY}methodauth.getToken${API_SECRET}`),
    );
  });

  it('signs every scrobble parameter, sorted, ignoring the order they were built in', async () => {
    const { host, requests } = stubHost(() => JSON.stringify({ scrobbles: { '@attr': {} } }));
    const client = new LastfmClient(host, API_KEY, API_SECRET);

    await client.scrobble('sess-1', [
      {
        track: track({ album: { uri: 'audius:album:1', name: 'Gülümse' }, trackNumber: 4 }),
        playedAt: Date.now() - 60_000,
      },
    ]);

    const req = requests[0]!;
    expect(req.method).toBe('POST');

    const pairs = sentParams(req);
    const sig = pairs.find(([k]) => k === 'api_sig')?.[1];
    const signable = pairs.filter(([k]) => k !== 'api_sig' && k !== 'format');
    const sorted = [...signable].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    expect(signable.map(([k]) => k)).toContain('album[0]');
    expect(sig).toBe(md5Hex(concatPairs(sorted) + API_SECRET));
    // The params go on the wire in build order, which is not the signing order.
    expect(signable.map(([k]) => k)).not.toEqual(sorted.map(([k]) => k));
    expect(sig).not.toBe(md5Hex(concatPairs(signable) + API_SECRET));
  });

  it('signs the UTF-8 form of a non-ASCII artist name', async () => {
    const { host, requests } = stubHost(() => JSON.stringify({ nowplaying: {} }));
    const client = new LastfmClient(host, API_KEY, API_SECRET);

    await client.updateNowPlaying('sess-1', track({ title: 'Şarkı', artists: [{ uri: 'a:artist:1', name: 'Şebnem Ferah' }] }));

    const pairs = sentParams(requests[0]!);
    const sig = pairs.find(([k]) => k === 'api_sig')?.[1];
    const sorted = pairs
      .filter(([k]) => k !== 'api_sig' && k !== 'format')
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    expect(sorted.some(([, v]) => v === 'Şebnem Ferah')).toBe(true);
    expect(sig).toBe(md5Hex(concatPairs(sorted) + API_SECRET));
    expect(sig).toHaveLength(32);
  });
});
