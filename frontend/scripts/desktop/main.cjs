// 桌面测试壳：Electron 加载 H5 构建产物（dist/build/h5）。
// 本地起 127.0.0.1 随机端口静态服务，规避 file:// 下 /static 绝对路径失效问题。
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const DIST = path.join(__dirname, '..', '..', 'dist', 'build', 'h5')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

/** 静态服务：找不到的路径一律回退 index.html（uni-app H5 hash 路由入口）。 */
function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0])
      const relative = path.normalize(url).replace(/^([/\\])+/, '')
      let filePath = path.join(DIST, relative)
      if (!filePath.startsWith(DIST)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      if (url === '/' || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        // SPA 导航（无扩展名）才回落 index.html；带扩展名的资源缺失必须 404，
        // 否则 img 拿到 HTML 表现为「破图」，掩盖真实路径错误
        if (path.extname(url) === '') {
          filePath = path.join(DIST, 'index.html')
        } else {
          res.writeHead(404)
          res.end('Not Found')
          return
        }
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404)
          res.end('Not Found')
          return
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' })
        res.end(data)
      })
    })
    server.on('error', reject)
    // 仅绑定回环地址，端口随机避免冲突
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function createWindow() {
  const server = await startStaticServer()
  const { port } = server.address()
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    useContentSize: true,
    autoHideMenuBar: true,
    title: '知芽 Learnly',
    webPreferences: { contextIsolation: true },
  })
  win.on('closed', () => server.close())
  win.loadURL(`http://127.0.0.1:${port}/`)
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
