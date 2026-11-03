import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import './assets/fonts/fonts.css';
import './squisq-monaco-workers.js';
import './styles.css';
import { SignInGate } from './sign-in/SignInGate.js';
import { installStaleBundleRecovery } from './stale-bundle-recovery.js';

installStaleBundleRecovery();
const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <SignInGate>
      <App />
    </SignInGate>
  </React.StrictMode>,
);
