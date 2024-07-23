import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    open: true,
  },
  build: {
    minify: 'esbuild',
    target: 'es2019',
    lib: {
      // Could also be a dictionary or array of multiple entry points
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'atm0s media SDK',
      // the proper extensions will be added
      fileName: 'atm0s-media-sdk',
    },
  },
});
