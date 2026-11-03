import { useState } from 'react';

export default function App() {
  const [openedAt] = useState(() => new Date().toLocaleTimeString());

  return (
    <main>
      <h1>Hello World</h1>
      <p>Hello World from App.tsx, opened at {openedAt}.</p>
    </main>
  );
}
