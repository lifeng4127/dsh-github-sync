// 通过本地代理建立 CONNECT 隧道，检查 api.github.com 拿到的证书是谁签的
import net from 'node:net';
import tls from 'node:tls';

const PROXY = { host: '127.0.0.1', port: Number(process.argv[2] || 7892) };
const TARGET = 'api.github.com';

function tunnel() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PROXY.port, PROXY.host, () => {
      sock.write(`CONNECT ${TARGET}:443 HTTP/1.1\r\nHost: ${TARGET}:443\r\nProxy-Connection: keep-alive\r\n\r\n`);
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      const line = buf.split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 200/.test(line)) return reject(new Error('隧道失败: ' + line));
      resolve(sock);
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

console.log('代理:', `${PROXY.host}:${PROXY.port}`, '→', TARGET);

// 1) 不做校验，看证书内容
await new Promise((resolve) => {
  tunnel().then((sock) => {
    const s = tls.connect({ socket: sock, servername: TARGET, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate(true);
      console.log('\n[不校验] subject :', JSON.stringify(c.subject));
      console.log('[不校验] issuer  :', JSON.stringify(c.issuer));
      console.log('[不校验] 有效期至:', c.valid_to);
      const san = (c.subjectaltname || '').split(',').slice(0, 3).join(',');
      console.log('[不校验] SAN     :', san);
      s.destroy();
      resolve();
    });
    s.on('error', (e) => { console.log('[不校验] tls error:', e.code || '', e.message); resolve(); });
  }).catch((e) => { console.log('隧道建立失败:', e.message); resolve(); });
});

// 2) 正常校验，复现插件看到的错误
await new Promise((resolve) => {
  tunnel().then((sock) => {
    const s = tls.connect({ socket: sock, servername: TARGET }, () => {
      console.log('\n[校验] 握手成功，证书受信任（不是 MITM）');
      s.destroy();
      resolve();
    });
    s.on('error', (e) => { console.log('[校验] 失败:', e.code || e.name, '-', e.message); resolve(); });
  }).catch((e) => { console.log('隧道建立失败:', e.message); resolve(); });
});
