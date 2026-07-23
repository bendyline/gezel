import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App.js';
import { RunsProvider } from './RunsContext.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('no #root element');
createRoot(root).render(
  <StrictMode>
    <RunsProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </RunsProvider>
  </StrictMode>,
);
