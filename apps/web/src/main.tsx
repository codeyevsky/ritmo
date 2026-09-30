import '@fontsource-variable/inter';
import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RitmoApp } from '@ritmo/ui';

import { boot } from './boot';
import { BootScreen } from './BootScreen';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');
const root = createRoot(container);

// The window is created hidden (see tauri.conf.json) so the user never sees an
// unstyled flash; the boot screen is the first thing painted, and RitmoApp
// reveals the window once it has mounted.
root.render(<BootScreen step="host" />);

boot((step) => root.render(<BootScreen step={step} />))
  .then((services) => {
    root.render(
      <StrictMode>
        <RitmoApp services={services} />
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    console.error('boot failed', error);
    root.render(<BootScreen step="error" error={error} />);
  });
