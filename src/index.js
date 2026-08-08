import React from 'react';
import ReactDOM from 'react-dom/client';
import Cortex from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><Cortex /></React.StrictMode>);

// Register service worker for PWA offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
