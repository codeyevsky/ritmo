//! Metadata extraction for files on disk.
//!
//! Everything here is pure: given a path it reads bytes and returns values. No
//! database, no state, so the scanner can call it from a rayon worker.

use std::path::Path;

use lofty::config::{ParseOptions, ParsingMode};
use lofty::file::{AudioFile, TaggedFile, TaggedFileExt};
use lofty::picture::PictureType;
use lofty::prelude::Accessor;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, Tag};

use crate::error::{AppError, AppResult};

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "mp4", "aac", "ogg", "oga", "opus", "wav", "wv", "aiff", "aif", "alac",
    "ape", "mpc",
];

#[derive(Debug, Clone)]
pub struct FileTags {
    pub title: String,
    pub artists: Vec<String>,
    pub album_artist: Option<String>,
    pub album: Option<String>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub date: Option<String>,
    pub genres: Vec<String>,
    pub duration_ms: u64,
    pub gain_db: Option<f32>,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub has_embedded_art: bool,
}

pub fn is_audio_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let ext = ext.to_ascii_lowercase();
            AUDIO_EXTENSIONS.contains(&ext.as_str())
        }
        None => false,
    }
}

pub fn read(path: &Path) -> AppResult<FileTags> {
    let tagged = probe(path, true)?;
    let props = tagged.properties();

    // Primary tag first so an MP3 carrying both ID3v2 and APE resolves the way
    // the rest of the world reads it, with the other tags as fallback.
    let primary_type = tagged.primary_tag().map(Tag::tag_type);
    let mut tags: Vec<&Tag> = Vec::with_capacity(tagged.tags().len());
    if let Some(t) = tagged.primary_tag() {
        tags.push(t);
    }
    for t in tagged.tags() {
        if Some(t.tag_type()) != primary_type {
            tags.push(t);
        }
    }

    let mut artists = collect_names(&tags, &ItemKey::TrackArtists);
    if artists.is_empty() {
        artists = collect_names(&tags, &ItemKey::TrackArtist);
    }

    let title = first_text(&tags, &ItemKey::TrackTitle)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| String::from("Unknown"))
        });

    let date = first_text(&tags, &ItemKey::RecordingDate)
        .or_else(|| first_text(&tags, &ItemKey::ReleaseDate))
        .or_else(|| first_text(&tags, &ItemKey::OriginalReleaseDate))
        .or_else(|| first_text(&tags, &ItemKey::Year))
        .map(str::to_owned);

    let mut genres = Vec::new();
    for raw in all_text(&tags, &ItemKey::Genre) {
        for part in raw.split([';', ',']) {
            let part = part.trim();
            if !part.is_empty() && !genres.iter().any(|g: &String| g == part) {
                genres.push(part.to_owned());
            }
        }
    }

    let gain_db = first_text(&tags, &ItemKey::ReplayGainTrackGain)
        .and_then(parse_gain_db)
        .or_else(|| r128_track_gain(&tags));

    Ok(FileTags {
        title,
        artists,
        album_artist: first_text(&tags, &ItemKey::AlbumArtist).map(str::to_owned),
        album: first_text(&tags, &ItemKey::AlbumTitle).map(str::to_owned),
        track_number: number(&tags, &ItemKey::TrackNumber)
            .or_else(|| tags.first().and_then(|t| t.track())),
        disc_number: number(&tags, &ItemKey::DiscNumber)
            .or_else(|| tags.first().and_then(|t| t.disk())),
        date,
        genres,
        duration_ms: props.duration().as_millis() as u64,
        gain_db,
        bitrate: props.audio_bitrate().or_else(|| props.overall_bitrate()),
        sample_rate: props.sample_rate(),
        channels: props.channels(),
        has_embedded_art: tags
            .iter()
            .any(|t| t.pictures().iter().any(|p| !p.data().is_empty())),
    })
}

/// Front cover if the file marks one, otherwise the first non-empty picture.
pub(crate) fn read_picture(path: &Path) -> Option<Vec<u8>> {
    let tagged = probe(path, false).ok()?;
    let mut fallback: Option<&[u8]> = None;
    for tag in tagged.tags() {
        for pic in tag.pictures() {
            if pic.data().is_empty() {
                continue;
            }
            if pic.pic_type() == PictureType::CoverFront {
                return Some(pic.data().to_vec());
            }
            if fallback.is_none() {
                fallback = Some(pic.data());
            }
        }
    }
    fallback.map(<[u8]>::to_vec)
}

/// Search/grouping form of a string.
///
/// Mirrors `normalizeKey` in `packages/core/src/util/text.ts`, whose pipeline
/// is: lowercase, Unicode NFD, drop the combining marks in `U+0300..=U+036F`,
/// fold Turkish `İ`/`I`/`ı` onto `i` (and `ş ğ ü ö ç` onto ASCII, which the
/// decomposition already does), drop everything that is not a letter, digit or
/// space, then collapse whitespace.
///
/// Nothing in the dependency set implements NFD, so the decomposition is baked
/// into [`FOLD_FROM`]/[`FOLD_TO`]: for every character whose canonical
/// decomposition loses its marks, the letter that survives. Already-decomposed
/// input goes down the same path because the marks are stripped directly. The
/// two implementations were checked against each other across the whole BMP.
pub fn normalize_key(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut gap = false;
    for c in s.chars().flat_map(char::to_lowercase) {
        if is_stripped_mark(c) {
            continue;
        }
        match hangul_jamo(c) {
            Some(jamo) => {
                for part in jamo {
                    push_key_char(&mut out, &mut gap, part);
                }
            }
            None => push_key_char(&mut out, &mut gap, fold(c)),
        }
    }
    out
}

/// Whitespace is only emitted once a keepable character follows it, which
/// trims both ends and collapses runs in one pass.
fn push_key_char(out: &mut String, gap: &mut bool, c: char) {
    if c.is_whitespace() {
        *gap = !out.is_empty();
        return;
    }
    if !c.is_alphanumeric() {
        return;
    }
    if *gap {
        out.push(' ');
        *gap = false;
    }
    out.push(c);
}

/// The marks NFD exposes and the TypeScript side strips, plus the two kana
/// voicing marks, which are not letters on either side.
fn is_stripped_mark(c: char) -> bool {
    matches!(c, '\u{0300}'..='\u{036F}' | '\u{3099}'..='\u{309A}')
}

fn fold(c: char) -> char {
    match FOLD_FROM.binary_search(&c) {
        Ok(i) => FOLD_TO.get(i).copied().unwrap_or(c),
        Err(_) => c,
    }
}

/// Hangul syllables decompose arithmetically rather than by table. The filler
/// `\0` for a syllable without a final consonant is dropped downstream, since
/// it is not alphanumeric.
fn hangul_jamo(c: char) -> Option<[char; 3]> {
    let syllable = u32::from(c);
    if !(0xAC00..=0xD7A3).contains(&syllable) {
        return None;
    }
    let index = syllable - 0xAC00;
    let final_index = index % 28;
    Some([
        char::from_u32(0x1100 + index / 588)?,
        char::from_u32(0x1161 + (index % 588) / 28)?,
        if final_index == 0 {
            '\0'
        } else {
            char::from_u32(0x11A7 + final_index)?
        },
    ])
}

fn probe(path: &Path, properties: bool) -> AppResult<TaggedFile> {
    // Relaxed: a single malformed frame must not cost us the whole file.
    let options = ParseOptions::new()
        .read_properties(properties)
        .parsing_mode(ParsingMode::Relaxed);
    let mut probe = Probe::open(path)
        .map_err(|e| decode_err(path, e))?
        .options(options);
    if probe.file_type().is_none() {
        probe = probe.guess_file_type()?;
    }
    probe.read().map_err(|e| decode_err(path, e))
}

fn decode_err(path: &Path, e: impl std::fmt::Display) -> AppError {
    AppError::Decode(format!("{}: {e}", path.display()))
}

fn first_text<'a>(tags: &[&'a Tag], key: &ItemKey) -> Option<&'a str> {
    tags.iter()
        .copied()
        .filter_map(|tag| tag.get_string(key))
        .map(str::trim)
        .find(|s| !s.is_empty())
}

/// Owned, unlike [`first_text`], because `Tag::get_strings` ties the returned
/// strings to the key's borrow rather than to the tag's.
fn all_text(tags: &[&Tag], key: &ItemKey) -> Vec<String> {
    for tag in tags {
        let values: Vec<String> = tag
            .get_strings(key)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if !values.is_empty() {
            return values;
        }
    }
    Vec::new()
}

fn collect_names(tags: &[&Tag], key: &ItemKey) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in all_text(tags, key) {
        for name in split_names(&raw) {
            if !out.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
                out.push(name);
            }
        }
    }
    out
}

/// `;` and ` / ` separate credited artists. The spaces around the slash are
/// mandatory, which is what keeps "AC/DC" in one piece; `\0` shows up in
/// ID3v2.4 multi-value frames. "feat." is deliberately not a separator.
pub(crate) fn split_names(raw: &str) -> Vec<String> {
    raw.split(['\u{0}', ';'])
        .flat_map(|part| part.split(" / "))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn number(tags: &[&Tag], key: &ItemKey) -> Option<u32> {
    first_text(tags, key)
        .and_then(|s| s.split('/').next())
        .map(str::trim)
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n > 0)
}

/// `"-6.32 dB"` — the unit is optional and the sign may be explicit.
fn parse_gain_db(raw: &str) -> Option<f32> {
    let trimmed = raw
        .trim()
        .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c.is_whitespace());
    trimmed.parse::<f32>().ok().filter(|v| v.is_finite())
}

/// Opus carries gain as Q7.8 LUFS against -23; ReplayGain references -18.
fn r128_track_gain(tags: &[&Tag]) -> Option<f32> {
    for tag in tags {
        for item in tag.items() {
            let named = match item.key() {
                ItemKey::Unknown(key) => key.eq_ignore_ascii_case("R128_TRACK_GAIN"),
                _ => false,
            };
            if !named && !item.description().eq_ignore_ascii_case("R128_TRACK_GAIN") {
                continue;
            }
            if let Some(q) = item
                .value()
                .text()
                .and_then(|s| s.trim().parse::<f32>().ok())
            {
                return Some(q / 256.0 + 5.0);
            }
        }
    }
    None
}

/// Fold table, generated from the Unicode character database: every lowercase
/// BMP character whose NFD decomposition is a base letter plus combining marks
/// that `normalize_key` strips, mapped to the letter that survives. Covers
/// Latin-1 through Latin Extended Additional, IPA, Greek, Cyrillic and the
/// kana, i.e. the whole of NFD's single-letter output — Hangul is handled
/// arithmetically instead, in [`hangul_jamo`]. `FOLD_FROM` is sorted, so
/// the lookup is a binary search.
const FOLD_FROM: [char; 1003] = [
    'à', 'á', 'â', 'ã', 'ä', 'å', 'ç', 'è', 'é', 'ê', 'ë', 'ì', 'í', 'î', 'ï', 'ñ',
    'ò', 'ó', 'ô', 'õ', 'ö', 'ù', 'ú', 'û', 'ü', 'ý', 'ÿ', 'ā', 'ă', 'ą', 'ć', 'ĉ',
    'ċ', 'č', 'ď', 'ē', 'ĕ', 'ė', 'ę', 'ě', 'ĝ', 'ğ', 'ġ', 'ģ', 'ĥ', 'ĩ', 'ī', 'ĭ',
    'į', 'ı', 'ĵ', 'ķ', 'ĺ', 'ļ', 'ľ', 'ń', 'ņ', 'ň', 'ō', 'ŏ', 'ő', 'ŕ', 'ŗ', 'ř',
    'ś', 'ŝ', 'ş', 'š', 'ţ', 'ť', 'ũ', 'ū', 'ŭ', 'ů', 'ű', 'ų', 'ŵ', 'ŷ', 'ź', 'ż',
    'ž', 'ơ', 'ư', 'ǎ', 'ǐ', 'ǒ', 'ǔ', 'ǖ', 'ǘ', 'ǚ', 'ǜ', 'ǟ', 'ǡ', 'ǣ', 'ǧ', 'ǩ',
    'ǫ', 'ǭ', 'ǯ', 'ǰ', 'ǵ', 'ǹ', 'ǻ', 'ǽ', 'ǿ', 'ȁ', 'ȃ', 'ȅ', 'ȇ', 'ȉ', 'ȋ', 'ȍ',
    'ȏ', 'ȑ', 'ȓ', 'ȕ', 'ȗ', 'ș', 'ț', 'ȟ', 'ȧ', 'ȩ', 'ȫ', 'ȭ', 'ȯ', 'ȱ', 'ȳ', 'ʹ',
    'ΐ', 'ά', 'έ', 'ή', 'ί', 'ΰ', 'ϊ', 'ϋ', 'ό', 'ύ', 'ώ', 'ϓ', 'ϔ', 'й', 'ѐ', 'ё',
    'ѓ', 'ї', 'ќ', 'ѝ', 'ў', 'ѷ', 'ӂ', 'ӑ', 'ӓ', 'ӗ', 'ӛ', 'ӝ', 'ӟ', 'ӣ', 'ӥ', 'ӧ',
    'ӫ', 'ӭ', 'ӯ', 'ӱ', 'ӳ', 'ӵ', 'ӹ', 'آ', 'أ', 'ؤ', 'إ', 'ئ', 'ۀ', 'ۂ', 'ۓ', 'ऩ',
    'ऱ', 'ऴ', 'क़', 'ख़', 'ग़', 'ज़', 'ड़', 'ढ़', 'फ़', 'य़', 'ড়', 'ঢ়', 'য়', 'ਲ਼', 'ਸ਼', 'ਖ਼',
    'ਗ਼', 'ਜ਼', 'ਫ਼', 'ଡ଼', 'ଢ଼', 'ஔ', 'གྷ', 'ཌྷ', 'དྷ', 'བྷ', 'ཛྷ', 'ཀྵ', 'ဦ', 'ᬆ', 'ᬈ', 'ᬊ',
    'ᬌ', 'ᬎ', 'ᬒ', 'ḁ', 'ḃ', 'ḅ', 'ḇ', 'ḉ', 'ḋ', 'ḍ', 'ḏ', 'ḑ', 'ḓ', 'ḕ', 'ḗ', 'ḙ',
    'ḛ', 'ḝ', 'ḟ', 'ḡ', 'ḣ', 'ḥ', 'ḧ', 'ḩ', 'ḫ', 'ḭ', 'ḯ', 'ḱ', 'ḳ', 'ḵ', 'ḷ', 'ḹ',
    'ḻ', 'ḽ', 'ḿ', 'ṁ', 'ṃ', 'ṅ', 'ṇ', 'ṉ', 'ṋ', 'ṍ', 'ṏ', 'ṑ', 'ṓ', 'ṕ', 'ṗ', 'ṙ',
    'ṛ', 'ṝ', 'ṟ', 'ṡ', 'ṣ', 'ṥ', 'ṧ', 'ṩ', 'ṫ', 'ṭ', 'ṯ', 'ṱ', 'ṳ', 'ṵ', 'ṷ', 'ṹ',
    'ṻ', 'ṽ', 'ṿ', 'ẁ', 'ẃ', 'ẅ', 'ẇ', 'ẉ', 'ẋ', 'ẍ', 'ẏ', 'ẑ', 'ẓ', 'ẕ', 'ẖ', 'ẗ',
    'ẘ', 'ẙ', 'ẛ', 'ạ', 'ả', 'ấ', 'ầ', 'ẩ', 'ẫ', 'ậ', 'ắ', 'ằ', 'ẳ', 'ẵ', 'ặ', 'ẹ',
    'ẻ', 'ẽ', 'ế', 'ề', 'ể', 'ễ', 'ệ', 'ỉ', 'ị', 'ọ', 'ỏ', 'ố', 'ồ', 'ổ', 'ỗ', 'ộ',
    'ớ', 'ờ', 'ở', 'ỡ', 'ợ', 'ụ', 'ủ', 'ứ', 'ừ', 'ử', 'ữ', 'ự', 'ỳ', 'ỵ', 'ỷ', 'ỹ',
    'ἀ', 'ἁ', 'ἂ', 'ἃ', 'ἄ', 'ἅ', 'ἆ', 'ἇ', 'ἐ', 'ἑ', 'ἒ', 'ἓ', 'ἔ', 'ἕ', 'ἠ', 'ἡ',
    'ἢ', 'ἣ', 'ἤ', 'ἥ', 'ἦ', 'ἧ', 'ἰ', 'ἱ', 'ἲ', 'ἳ', 'ἴ', 'ἵ', 'ἶ', 'ἷ', 'ὀ', 'ὁ',
    'ὂ', 'ὃ', 'ὄ', 'ὅ', 'ὐ', 'ὑ', 'ὒ', 'ὓ', 'ὔ', 'ὕ', 'ὖ', 'ὗ', 'ὠ', 'ὡ', 'ὢ', 'ὣ',
    'ὤ', 'ὥ', 'ὦ', 'ὧ', 'ὰ', 'ά', 'ὲ', 'έ', 'ὴ', 'ή', 'ὶ', 'ί', 'ὸ', 'ό', 'ὺ', 'ύ',
    'ὼ', 'ώ', 'ᾀ', 'ᾁ', 'ᾂ', 'ᾃ', 'ᾄ', 'ᾅ', 'ᾆ', 'ᾇ', 'ᾐ', 'ᾑ', 'ᾒ', 'ᾓ', 'ᾔ', 'ᾕ',
    'ᾖ', 'ᾗ', 'ᾠ', 'ᾡ', 'ᾢ', 'ᾣ', 'ᾤ', 'ᾥ', 'ᾦ', 'ᾧ', 'ᾰ', 'ᾱ', 'ᾲ', 'ᾳ', 'ᾴ', 'ᾶ',
    'ᾷ', 'ι', 'ῂ', 'ῃ', 'ῄ', 'ῆ', 'ῇ', 'ῐ', 'ῑ', 'ῒ', 'ΐ', 'ῖ', 'ῗ', 'ῠ', 'ῡ', 'ῢ',
    'ΰ', 'ῤ', 'ῥ', 'ῦ', 'ῧ', 'ῲ', 'ῳ', 'ῴ', 'ῶ', 'ῷ', 'が', 'ぎ', 'ぐ', 'げ', 'ご', 'ざ',
    'じ', 'ず', 'ぜ', 'ぞ', 'だ', 'ぢ', 'づ', 'で', 'ど', 'ば', 'ぱ', 'び', 'ぴ', 'ぶ', 'ぷ', 'べ',
    'ぺ', 'ぼ', 'ぽ', 'ゔ', 'ゞ', 'ガ', 'ギ', 'グ', 'ゲ', 'ゴ', 'ザ', 'ジ', 'ズ', 'ゼ', 'ゾ', 'ダ',
    'ヂ', 'ヅ', 'デ', 'ド', 'バ', 'パ', 'ビ', 'ピ', 'ブ', 'プ', 'ベ', 'ペ', 'ボ', 'ポ', 'ヴ', 'ヷ',
    'ヸ', 'ヹ', 'ヺ', 'ヾ', '豈', '更', '車', '賈', '滑', '串', '句', '龜', '龜', '契', '金', '喇',
    '奈', '懶', '癩', '羅', '蘿', '螺', '裸', '邏', '樂', '洛', '烙', '珞', '落', '酪', '駱', '亂',
    '卵', '欄', '爛', '蘭', '鸞', '嵐', '濫', '藍', '襤', '拉', '臘', '蠟', '廊', '朗', '浪', '狼',
    '郎', '來', '冷', '勞', '擄', '櫓', '爐', '盧', '老', '蘆', '虜', '路', '露', '魯', '鷺', '碌',
    '祿', '綠', '菉', '錄', '鹿', '論', '壟', '弄', '籠', '聾', '牢', '磊', '賂', '雷', '壘', '屢',
    '樓', '淚', '漏', '累', '縷', '陋', '勒', '肋', '凜', '凌', '稜', '綾', '菱', '陵', '讀', '拏',
    '樂', '諾', '丹', '寧', '怒', '率', '異', '北', '磻', '便', '復', '不', '泌', '數', '索', '參',
    '塞', '省', '葉', '說', '殺', '辰', '沈', '拾', '若', '掠', '略', '亮', '兩', '凉', '梁', '糧',
    '良', '諒', '量', '勵', '呂', '女', '廬', '旅', '濾', '礪', '閭', '驪', '麗', '黎', '力', '曆',
    '歷', '轢', '年', '憐', '戀', '撚', '漣', '煉', '璉', '秊', '練', '聯', '輦', '蓮', '連', '鍊',
    '列', '劣', '咽', '烈', '裂', '說', '廉', '念', '捻', '殮', '簾', '獵', '令', '囹', '寧', '嶺',
    '怜', '玲', '瑩', '羚', '聆', '鈴', '零', '靈', '領', '例', '禮', '醴', '隸', '惡', '了', '僚',
    '寮', '尿', '料', '樂', '燎', '療', '蓼', '遼', '龍', '暈', '阮', '劉', '杻', '柳', '流', '溜',
    '琉', '留', '硫', '紐', '類', '六', '戮', '陸', '倫', '崙', '淪', '輪', '律', '慄', '栗', '率',
    '隆', '利', '吏', '履', '易', '李', '梨', '泥', '理', '痢', '罹', '裏', '裡', '里', '離', '匿',
    '溺', '吝', '燐', '璘', '藺', '隣', '鱗', '麟', '林', '淋', '臨', '立', '笠', '粒', '狀', '炙',
    '識', '什', '茶', '刺', '切', '度', '拓', '糖', '宅', '洞', '暴', '輻', '行', '降', '見', '廓',
    '兀', '嗀', '塚', '晴', '凞', '猪', '益', '礼', '神', '祥', '福', '靖', '精', '羽', '蘒', '諸',
    '逸', '都', '飯', '飼', '館', '鶴', '郞', '隷', '侮', '僧', '免', '勉', '勤', '卑', '喝', '嘆',
    '器', '塀', '墨', '層', '屮', '悔', '慨', '憎', '懲', '敏', '既', '暑', '梅', '海', '渚', '漢',
    '煮', '爫', '琢', '碑', '社', '祉', '祈', '祐', '祖', '祝', '禍', '禎', '穀', '突', '節', '練',
    '縉', '繁', '署', '者', '臭', '艹', '艹', '著', '褐', '視', '謁', '謹', '賓', '贈', '辶', '逸',
    '難', '響', '頻', '恵', '舘', '並', '况', '全', '侀', '充', '冀', '勇', '勺', '喝', '啕', '喙',
    '嗢', '塚', '墳', '奄', '奔', '婢', '嬨', '廒', '廙', '彩', '徭', '惘', '慎', '愈', '憎', '慠',
    '懲', '戴', '揄', '搜', '摒', '敖', '晴', '朗', '望', '杖', '歹', '殺', '流', '滛', '滋', '漢',
    '瀞', '煮', '瞧', '爵', '犯', '猪', '瑱', '甆', '画', '瘝', '瘟', '益', '盛', '直', '睊', '着',
    '磌', '窱', '節', '类', '絛', '練', '缾', '者', '荒', '華', '蝹', '襁', '覆', '視', '調', '諸',
    '請', '謁', '諾', '諭', '謹', '變', '贈', '輸', '遲', '醙', '鉶', '陼', '難', '靖', '韛', '響',
    '頋', '頻', '鬒', '龜', '㮝', '䀘', '䀹', '齃', '龎', 'יִ', 'ײַ', 'שׁ', 'שׂ', 'שּׁ', 'שּׂ', 'אַ',
    'אָ', 'אּ', 'בּ', 'גּ', 'דּ', 'הּ', 'וּ', 'זּ', 'טּ', 'יּ', 'ךּ', 'כּ', 'לּ', 'מּ', 'נּ', 'סּ',
    'ףּ', 'פּ', 'צּ', 'קּ', 'רּ', 'שּ', 'תּ', 'וֹ', 'בֿ', 'כֿ', 'פֿ',
];

const FOLD_TO: [char; 1003] = [
    'a', 'a', 'a', 'a', 'a', 'a', 'c', 'e', 'e', 'e', 'e', 'i', 'i', 'i', 'i', 'n',
    'o', 'o', 'o', 'o', 'o', 'u', 'u', 'u', 'u', 'y', 'y', 'a', 'a', 'a', 'c', 'c',
    'c', 'c', 'd', 'e', 'e', 'e', 'e', 'e', 'g', 'g', 'g', 'g', 'h', 'i', 'i', 'i',
    'i', 'i', 'j', 'k', 'l', 'l', 'l', 'n', 'n', 'n', 'o', 'o', 'o', 'r', 'r', 'r',
    's', 's', 's', 's', 't', 't', 'u', 'u', 'u', 'u', 'u', 'u', 'w', 'y', 'z', 'z',
    'z', 'o', 'u', 'a', 'i', 'o', 'u', 'u', 'u', 'u', 'u', 'a', 'a', 'æ', 'g', 'k',
    'o', 'o', 'ʒ', 'j', 'g', 'n', 'a', 'æ', 'ø', 'a', 'a', 'e', 'e', 'i', 'i', 'o',
    'o', 'r', 'r', 'u', 'u', 's', 't', 'h', 'a', 'e', 'o', 'o', 'o', 'o', 'y', 'ʹ',
    'ι', 'α', 'ε', 'η', 'ι', 'υ', 'ι', 'υ', 'ο', 'υ', 'ω', 'ϒ', 'ϒ', 'и', 'е', 'е',
    'г', 'і', 'к', 'и', 'у', 'ѵ', 'ж', 'а', 'а', 'е', 'ә', 'ж', 'з', 'и', 'и', 'о',
    'ө', 'э', 'у', 'у', 'у', 'ч', 'ы', 'ا', 'ا', 'و', 'ا', 'ي', 'ە', 'ہ', 'ے', 'न',
    'र', 'ळ', 'क', 'ख', 'ग', 'ज', 'ड', 'ढ', 'फ', 'य', 'ড', 'ঢ', 'য', 'ਲ', 'ਸ', 'ਖ',
    'ਗ', 'ਜ', 'ਫ', 'ଡ', 'ଢ', 'ஒ', 'ག', 'ཌ', 'ད', 'བ', 'ཛ', 'ཀ', 'ဥ', 'ᬅ', 'ᬇ', 'ᬉ',
    'ᬋ', 'ᬍ', 'ᬑ', 'a', 'b', 'b', 'b', 'c', 'd', 'd', 'd', 'd', 'd', 'e', 'e', 'e',
    'e', 'e', 'f', 'g', 'h', 'h', 'h', 'h', 'h', 'i', 'i', 'k', 'k', 'k', 'l', 'l',
    'l', 'l', 'm', 'm', 'm', 'n', 'n', 'n', 'n', 'o', 'o', 'o', 'o', 'p', 'p', 'r',
    'r', 'r', 'r', 's', 's', 's', 's', 's', 't', 't', 't', 't', 'u', 'u', 'u', 'u',
    'u', 'v', 'v', 'w', 'w', 'w', 'w', 'w', 'x', 'x', 'y', 'z', 'z', 'z', 'h', 't',
    'w', 'y', 'ſ', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'e',
    'e', 'e', 'e', 'e', 'e', 'e', 'e', 'i', 'i', 'o', 'o', 'o', 'o', 'o', 'o', 'o',
    'o', 'o', 'o', 'o', 'o', 'u', 'u', 'u', 'u', 'u', 'u', 'u', 'y', 'y', 'y', 'y',
    'α', 'α', 'α', 'α', 'α', 'α', 'α', 'α', 'ε', 'ε', 'ε', 'ε', 'ε', 'ε', 'η', 'η',
    'η', 'η', 'η', 'η', 'η', 'η', 'ι', 'ι', 'ι', 'ι', 'ι', 'ι', 'ι', 'ι', 'ο', 'ο',
    'ο', 'ο', 'ο', 'ο', 'υ', 'υ', 'υ', 'υ', 'υ', 'υ', 'υ', 'υ', 'ω', 'ω', 'ω', 'ω',
    'ω', 'ω', 'ω', 'ω', 'α', 'α', 'ε', 'ε', 'η', 'η', 'ι', 'ι', 'ο', 'ο', 'υ', 'υ',
    'ω', 'ω', 'α', 'α', 'α', 'α', 'α', 'α', 'α', 'α', 'η', 'η', 'η', 'η', 'η', 'η',
    'η', 'η', 'ω', 'ω', 'ω', 'ω', 'ω', 'ω', 'ω', 'ω', 'α', 'α', 'α', 'α', 'α', 'α',
    'α', 'ι', 'η', 'η', 'η', 'η', 'η', 'ι', 'ι', 'ι', 'ι', 'ι', 'ι', 'υ', 'υ', 'υ',
    'υ', 'ρ', 'ρ', 'υ', 'υ', 'ω', 'ω', 'ω', 'ω', 'ω', 'か', 'き', 'く', 'け', 'こ', 'さ',
    'し', 'す', 'せ', 'そ', 'た', 'ち', 'つ', 'て', 'と', 'は', 'は', 'ひ', 'ひ', 'ふ', 'ふ', 'へ',
    'へ', 'ほ', 'ほ', 'う', 'ゝ', 'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス', 'セ', 'ソ', 'タ',
    'チ', 'ツ', 'テ', 'ト', 'ハ', 'ハ', 'ヒ', 'ヒ', 'フ', 'フ', 'ヘ', 'ヘ', 'ホ', 'ホ', 'ウ', 'ワ',
    'ヰ', 'ヱ', 'ヲ', 'ヽ', '豈', '更', '車', '賈', '滑', '串', '句', '龜', '龜', '契', '金', '喇',
    '奈', '懶', '癩', '羅', '蘿', '螺', '裸', '邏', '樂', '洛', '烙', '珞', '落', '酪', '駱', '亂',
    '卵', '欄', '爛', '蘭', '鸞', '嵐', '濫', '藍', '襤', '拉', '臘', '蠟', '廊', '朗', '浪', '狼',
    '郎', '來', '冷', '勞', '擄', '櫓', '爐', '盧', '老', '蘆', '虜', '路', '露', '魯', '鷺', '碌',
    '祿', '綠', '菉', '錄', '鹿', '論', '壟', '弄', '籠', '聾', '牢', '磊', '賂', '雷', '壘', '屢',
    '樓', '淚', '漏', '累', '縷', '陋', '勒', '肋', '凜', '凌', '稜', '綾', '菱', '陵', '讀', '拏',
    '樂', '諾', '丹', '寧', '怒', '率', '異', '北', '磻', '便', '復', '不', '泌', '數', '索', '參',
    '塞', '省', '葉', '說', '殺', '辰', '沈', '拾', '若', '掠', '略', '亮', '兩', '凉', '梁', '糧',
    '良', '諒', '量', '勵', '呂', '女', '廬', '旅', '濾', '礪', '閭', '驪', '麗', '黎', '力', '曆',
    '歷', '轢', '年', '憐', '戀', '撚', '漣', '煉', '璉', '秊', '練', '聯', '輦', '蓮', '連', '鍊',
    '列', '劣', '咽', '烈', '裂', '說', '廉', '念', '捻', '殮', '簾', '獵', '令', '囹', '寧', '嶺',
    '怜', '玲', '瑩', '羚', '聆', '鈴', '零', '靈', '領', '例', '禮', '醴', '隸', '惡', '了', '僚',
    '寮', '尿', '料', '樂', '燎', '療', '蓼', '遼', '龍', '暈', '阮', '劉', '杻', '柳', '流', '溜',
    '琉', '留', '硫', '紐', '類', '六', '戮', '陸', '倫', '崙', '淪', '輪', '律', '慄', '栗', '率',
    '隆', '利', '吏', '履', '易', '李', '梨', '泥', '理', '痢', '罹', '裏', '裡', '里', '離', '匿',
    '溺', '吝', '燐', '璘', '藺', '隣', '鱗', '麟', '林', '淋', '臨', '立', '笠', '粒', '狀', '炙',
    '識', '什', '茶', '刺', '切', '度', '拓', '糖', '宅', '洞', '暴', '輻', '行', '降', '見', '廓',
    '兀', '嗀', '塚', '晴', '凞', '猪', '益', '礼', '神', '祥', '福', '靖', '精', '羽', '蘒', '諸',
    '逸', '都', '飯', '飼', '館', '鶴', '郞', '隷', '侮', '僧', '免', '勉', '勤', '卑', '喝', '嘆',
    '器', '塀', '墨', '層', '屮', '悔', '慨', '憎', '懲', '敏', '既', '暑', '梅', '海', '渚', '漢',
    '煮', '爫', '琢', '碑', '社', '祉', '祈', '祐', '祖', '祝', '禍', '禎', '穀', '突', '節', '練',
    '縉', '繁', '署', '者', '臭', '艹', '艹', '著', '褐', '視', '謁', '謹', '賓', '贈', '辶', '逸',
    '難', '響', '頻', '恵', '舘', '並', '况', '全', '侀', '充', '冀', '勇', '勺', '喝', '啕', '喙',
    '嗢', '塚', '墳', '奄', '奔', '婢', '嬨', '廒', '廙', '彩', '徭', '惘', '慎', '愈', '憎', '慠',
    '懲', '戴', '揄', '搜', '摒', '敖', '晴', '朗', '望', '杖', '歹', '殺', '流', '滛', '滋', '漢',
    '瀞', '煮', '瞧', '爵', '犯', '猪', '瑱', '甆', '画', '瘝', '瘟', '益', '盛', '直', '睊', '着',
    '磌', '窱', '節', '类', '絛', '練', '缾', '者', '荒', '華', '蝹', '襁', '覆', '視', '調', '諸',
    '請', '謁', '諾', '諭', '謹', '變', '贈', '輸', '遲', '醙', '鉶', '陼', '難', '靖', '韛', '響',
    '頋', '頻', '鬒', '龜', '㮝', '䀘', '䀹', '齃', '龎', 'י', 'ײ', 'ש', 'ש', 'ש', 'ש', 'א',
    'א', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ט', 'י', 'ך', 'כ', 'ל', 'מ', 'נ', 'ס',
    'ף', 'פ', 'צ', 'ק', 'ר', 'ש', 'ת', 'ו', 'ב', 'כ', 'פ',
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_turkish_and_diacritics() {
        assert_eq!(normalize_key("İstanbul"), "istanbul");
        assert_eq!(normalize_key("IŞIK"), "isik");
        assert_eq!(normalize_key("Gündoğdu"), "gundogdu");
        assert_eq!(normalize_key("  Çöp   Adam!  "), "cop adam");
        assert_eq!(normalize_key("Beyoncé"), "beyonce");
        assert_eq!(normalize_key("Sigur Rós"), "sigur ros");
        assert_eq!(normalize_key("Phượng"), "phuong");
        assert_eq!(normalize_key("Ά"), "α");
        // Already-decomposed input must land on the same key.
        assert_eq!(normalize_key("Beyonce\u{0301}"), normalize_key("Beyoncé"));
        assert_eq!(normalize_key("!!!"), "");
    }

    #[test]
    fn fold_table_is_searchable() {
        assert!(FOLD_FROM.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(FOLD_FROM.len(), FOLD_TO.len());
        // Hangul is decomposed arithmetically, matching NFD's conjoining jamo.
        assert_eq!(
            normalize_key("강").chars().collect::<Vec<char>>(),
            vec!['\u{1100}', '\u{1161}', '\u{11BC}']
        );
    }

    #[test]
    fn splits_credited_artists_but_keeps_slashes_in_names() {
        assert_eq!(split_names("AC/DC"), vec!["AC/DC".to_owned()]);
        assert_eq!(
            split_names("Sia; David Guetta"),
            vec!["Sia".to_owned(), "David Guetta".to_owned()]
        );
        assert_eq!(
            split_names("Simon / Garfunkel"),
            vec!["Simon".to_owned(), "Garfunkel".to_owned()]
        );
        assert_eq!(
            split_names("Massive Attack feat. Tracey Thorn"),
            vec!["Massive Attack feat. Tracey Thorn".to_owned()]
        );
    }

    #[test]
    fn parses_replaygain_forms() {
        assert_eq!(parse_gain_db("-6.32 dB"), Some(-6.32));
        assert_eq!(parse_gain_db("+3.4dB"), Some(3.4));
        assert_eq!(parse_gain_db("0.00 DB"), Some(0.0));
        assert_eq!(parse_gain_db("nonsense"), None);
    }
}
