import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type {
  AudioEngine,
  Bazaar,
  HostBridge,
  Library,
  MetadataService,
  Packs,
  PlaybackController,
  ProviderRegistry,
  Settings,
} from '@ritmo/core';

/**
 * Everything the UI is allowed to touch. `apps/web` builds these once at
 * startup and hands them down; no component ever constructs a service itself,
 * and nothing in the UI imports a platform API directly.
 */
export interface RitmoServices {
  host: HostBridge;
  engine: AudioEngine;
  registry: ProviderRegistry;
  library: Library;
  packs: Packs;
  bazaar: Bazaar;
  controller: PlaybackController;
  metadata: MetadataService;
  settings: Settings;
}

export const ServicesContext = createContext<RitmoServices | null>(null);

export interface ServicesProviderProps {
  value: RitmoServices;
  children: ReactNode;
}

export function ServicesProvider({ value, children }: ServicesProviderProps) {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): RitmoServices {
  const services = useContext(ServicesContext);
  if (!services) {
    throw new Error(
      'useServices() was called outside <ServicesProvider>. Render <RitmoApp services={...} /> ' +
        'or wrap the tree in <ServicesProvider value={services}> first.',
    );
  }
  return services;
}

export function useHost(): HostBridge {
  return useServices().host;
}

export function useController(): PlaybackController {
  return useServices().controller;
}

export function useLibraryService(): Library {
  return useServices().library;
}

export function usePacksService(): Packs {
  return useServices().packs;
}

export function useBazaar(): Bazaar {
  return useServices().bazaar;
}

export function useRegistry(): ProviderRegistry {
  return useServices().registry;
}
