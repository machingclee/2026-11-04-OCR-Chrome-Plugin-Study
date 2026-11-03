import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './popup.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('The popup root element is missing.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
