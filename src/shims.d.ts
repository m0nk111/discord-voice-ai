// Ambient declarations for dependencies that don't ship TypeScript types.

declare module 'ffmpeg-static' {
  const path: string;
  export default path;
}

declare module 'prism-media';
