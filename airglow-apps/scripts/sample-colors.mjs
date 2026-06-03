import { readFileSync } from 'fs';
import zlib from 'zlib';

// Minimal PNG RGB sampler — supports 8-bit truecolor / truecolor+alpha, non-interlaced.
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not png');
  let i = 8;
  let width=0, height=0, depth=0, colorType=0;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i); i += 4;
    const type = buf.slice(i, i+4).toString('ascii'); i += 4;
    const data = buf.slice(i, i+len); i += len;
    i += 4; // crc
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : (() => { throw new Error('unsupported colorType ' + colorType); })();
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride);
  let ri = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[ri++];
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = raw[ri++];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + Math.floor((a + b) / 2)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        let pr;
        if (pa <= pb && pa <= pc) pr = a;
        else if (pb <= pc) pr = b;
        else pr = c;
        v = (v + pr) & 0xff;
      }
      row[x] = v;
    }
    for (let x = 0; x < width; x++) {
      out[(y*width+x)*3] = row[x*bpp];
      out[(y*width+x)*3+1] = row[x*bpp+1];
      out[(y*width+x)*3+2] = row[x*bpp+2];
    }
    prev = row;
  }
  return { width, height, rgb: out };
}

function pixel(img, x, y) {
  const i = (y*img.width + x)*3;
  return [img.rgb[i], img.rgb[i+1], img.rgb[i+2]];
}
const hex = ([r,g,b]) => '#' + [r,g,b].map(n=>n.toString(16).padStart(2,'0')).join('');

const img = decodePNG(readFileSync(process.argv[2]));
console.log('size:', img.width, 'x', img.height);
// Sample at proportional coordinates
// Average a small patch instead of single pixel — avoids text/anti-aliasing artifacts.
function patch(img, cx, cy, r=6) {
  let R=0,G=0,B=0,n=0;
  for (let y=cy-r;y<=cy+r;y++) for (let x=cx-r;x<=cx+r;x++) {
    const i = (y*img.width+x)*3;
    R+=img.rgb[i]; G+=img.rgb[i+1]; B+=img.rgb[i+2]; n++;
  }
  return [Math.round(R/n), Math.round(G/n), Math.round(B/n)];
}
const probes = [
  ['left nav bg, low',       100, 1000],
  ['left nav bg, mid',       100, 600],
  ['active item Dashboard',  130, 185],
  ['main bg (far right)',    2400, 800],
  ['main bg (mid)',          1200, 700],
  ['card outline area',      600, 280],
  ['card inside',            1300, 380],
  ['Sync btn center',        2720, 140],
  ['Sync btn left edge',     2620, 140],
  ['Sync btn right edge',    2820, 140],
];
const samples = probes.map(([l,x,y]) => [l, x/(img.width-1), y/(img.height-1)]);
// Override pixel() to use patch averaging
const _orig = pixel; (globalThis).pixel = (img,x,y)=>patch(img,x,y,5);
for (const [label, fx, fy] of samples) {
  const x = Math.round(fx * (img.width-1));
  const y = Math.round(fy * (img.height-1));
  const c = patch(img, x, y, 6);
  console.log(`  ${label.padEnd(40)} (${x},${y}) -> ${hex(c)}  rgb(${c.join(',')})`);
}
