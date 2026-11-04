import './style.css';
import { App } from './ui/app.ts';

const root = document.querySelector<HTMLElement>('#app');
if (!root) {
  throw new Error('ChainPad could not find its mount point (#app).');
}

const app = new App(root);
void app.init();

// The service worker makes the shell work offline. Compilers are cached by
// `solc.ts` separately, so a second compile also works without a network.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Offline support is a bonus; the app works fine without it.
    });
  });
}
