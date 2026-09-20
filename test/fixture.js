// テスト用の小さなサーバ。/set-marker?v=... で返す HTML の中身を変えられる。
const http = require('http');

let marker = 'v1';

// 8kHz モノラル 1 秒の無音 WAV。再生中の判定を試すためだけのもの。
function silentWav() {
  const rate = 8000, seconds = 1, dataLen = rate * seconds;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  buf.fill(128, 44);
  return buf;
}

const WAV = silentWav();

const page = () => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>fixture</title></head>
<body>
  <h1 id="marker">${marker}</h1>
  <form>
    <input id="txt" name="txt" type="text" autocomplete="off">
    <input id="pw" name="pw" type="password" autocomplete="off">
    <textarea id="area" name="area"></textarea>
    <label><input id="chk" name="chk" type="checkbox"> check</label>
  </form>
  <div style="height:4000px">spacer</div>
  <script>
    const n = Number(sessionStorage.getItem('loads') || '0') + 1;
    sessionStorage.setItem('loads', String(n));
    window.__loads = n;
  </script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/set-marker')) {
    marker = new URL(req.url, 'http://x').searchParams.get('v') || marker;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url.startsWith('/tone.wav')) {
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': WAV.length });
    res.end(WAV);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page());
});

module.exports = { server };
if (require.main === module) server.listen(8765);
