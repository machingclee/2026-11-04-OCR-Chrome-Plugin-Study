import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

type SelectedImage = {
  url: string;
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
};

function formatSize(bytes: number): string {
  const kilobytes = bytes / 1024;
  return kilobytes < 1024
    ? `${Math.round(kilobytes)} KB`
    : `${(kilobytes / 1024).toFixed(1)} MB`;
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [openedAt] = useState(() => new Date().toLocaleTimeString());
  const [image, setImage] = useState<SelectedImage | null>(null);
  const url = image?.url;

  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  const handleFile = (file: File | undefined): void => {
    if (!file) return;
    setImage({
      url: URL.createObjectURL(file),
      name: file.name,
      type: file.type || 'unknown',
      size: file.size,
      width: 0,
      height: 0,
    });
  };

  const handleLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    setImage((current) =>
      current ? { ...current, width: naturalWidth, height: naturalHeight } : current,
    );
  };

  return (
    <main>
      <h1>Comic Translator</h1>
      <p>Hello World from App.tsx, opened at {openedAt}.</p>

      <button type="button" onClick={() => inputRef.current?.click()}>
        Choose an image
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          handleFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />

      {image ? (
        <figure>
          <img src={image.url} alt={image.name} onLoad={handleLoad} />
          <figcaption>
            {image.name} · {image.type} · {formatSize(image.size)}
            {image.width > 0 ? ` · ${image.width}×${image.height}` : ''}
          </figcaption>
          <code>{image.url}</code>
        </figure>
      ) : (
        <p>No image selected.</p>
      )}
    </main>
  );
}
