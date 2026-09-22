/**
 * pdfmake, set up once for every PDF the tracker builds: the bundled Roboto
 * fonts, and no access to anything else. PDFs are built only from our own
 * data, so they may read those fonts and never fetch a URL; tightening this
 * here tightens it for all of them.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import pdfmake from 'pdfmake';

const require = createRequire(import.meta.url);
const ROBOTO = require('pdfmake/fonts/Roboto.js');
const FONT_DIR = resolve(dirname(ROBOTO.Roboto.normal));

pdfmake.setFonts(ROBOTO);
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => resolve(path).startsWith(FONT_DIR));

export default pdfmake;
