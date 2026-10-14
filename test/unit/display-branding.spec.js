// desktop-display-branding 1.1 / 1.2: the visible name and icon set are
// Promethity, while productName and the app id stay as they were so existing
// installs keep their userData directory, settings and stored tokens.

const fs = require('fs')
const path = require('path')
const { test, expect } = require('@playwright/test')

const root = path.join(__dirname, '../..')
const pkg = require('../../package.json')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const pngSize = (file) => {
  const buf = fs.readFileSync(file)
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  return entry.isDirectory() ? walk(full) : [full]
})

test.describe('Identity that must not change', () => {
  test('productName, name and appId are the originals', () => {
    expect(pkg.productName).toBe('IPFS Desktop')
    expect(pkg.name).toBe('ipfs-desktop')
    expect(read('electron-builder.yml')).toMatch(/^appId: io\.ipfs\.desktop$/m)
  })

  test('the inputs Electron derives the userData directory from still yield "IPFS Desktop"', () => {
    // Static check on package.json only: Electron names the app from productName
    // (falling back to name) and puts userData at <appData>/<app name>. It does
    // not call app.getPath('userData'); the real Electron assertion runs at the
    // phase gate, not in this unit spec.
    const appName = pkg.productName || pkg.name
    expect(path.join('/appData', appName)).toBe(path.join('/appData', 'IPFS Desktop'))
  })

  test('no source renames the app or moves userData outside the test harness', () => {
    const offenders = []
    for (const file of walk(path.join(root, 'src')).filter((f) => f.endsWith('.js'))) {
      const rel = path.relative(root, file)
      const source = fs.readFileSync(file, 'utf8')
      if (/app\.setName\(/.test(source)) offenders.push(`${rel}: app.setName`)
      if (/setPath\(\s*['"]userData['"]/.test(source) && rel !== path.join('src', 'index.js')) {
        offenders.push(`${rel}: setPath('userData')`)
      }
    }
    expect(offenders).toEqual([])
    // The one allowed call sits inside the NODE_ENV === 'test' branch.
    const index = read('src/index.js')
    const guard = index.indexOf("process.env.NODE_ENV === 'test'")
    expect(guard).toBeGreaterThan(-1)
    expect(index.slice(guard)).toMatch(/setPath\(\s*['"]userData['"]/)
    expect(index.slice(0, guard)).not.toMatch(/setPath\(\s*['"]userData['"]/)
  })
})

test.describe('Visible display name', () => {
  test('displayName is Promethity', () => {
    expect(pkg.displayName).toBe('Promethity')
    expect(require('../../src/webui/display-name')).toBe('Promethity')
  })

  test('the Web UI window and the tray tooltip use it, not a hard-coded name', () => {
    expect(read('src/webui/index.js')).toMatch(/title: DISPLAY_NAME,/)
    expect(read('src/webui/index.js')).not.toMatch(/title: 'IPFS Desktop'/)
    expect(read('src/tray.js')).toMatch(/setToolTip\(DISPLAY_NAME\)/)
    expect(read('src/tray.js')).not.toMatch(/setToolTip\('IPFS Desktop'\)/)
  })
})

test.describe('Icon files replaced at their existing paths', () => {
  const tray = path.join(root, 'assets/icons/tray')
  const build = path.join(root, 'assets/build')

  test('macOS tray template images keep their 18x22 grid at 1x, 2x and 3x', () => {
    for (const state of ['on', 'off']) {
      for (const [suffix, scale] of [['', 1], ['@2x', 2], ['@3x', 3]]) {
        const size = pngSize(path.join(tray, 'macos', `${state}-22Template${suffix}.png`))
        expect(size).toEqual({ width: 18 * scale, height: 22 * scale })
      }
    }
  })

  test('other-platform tray icons keep their sizes', () => {
    for (const state of ['on', 'off']) {
      for (const theme of ['dark', 'light']) {
        expect(pngSize(path.join(tray, 'others', `${state}-32-${theme}.png`))).toEqual({ width: 32, height: 32 })
      }
      expect(pngSize(path.join(tray, 'others', `${state}-large.png`))).toEqual({ width: 1024, height: 1024 })
    }
  })

  test('build icons are valid png, ico and icns files', () => {
    expect(pngSize(path.join(build, 'icon.png'))).toEqual({ width: 512, height: 512 })

    const ico = fs.readFileSync(path.join(build, 'icon.ico'))
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(6)

    const icns = fs.readFileSync(path.join(build, 'icon.icns'))
    expect(icns.subarray(0, 4).toString('latin1')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
  })

  test('installer art keeps the sizes electron-builder lays out', () => {
    expect(pngSize(path.join(build, 'background.png'))).toEqual({ width: 660, height: 400 })
    expect(pngSize(path.join(build, 'background@2x.png'))).toEqual({ width: 1320, height: 800 })
    const bmp = fs.readFileSync(path.join(build, 'installerSidebar.bmp'))
    expect(bmp.subarray(0, 2).toString('latin1')).toBe('BM')
    expect(bmp.readInt32LE(18)).toBe(328)
    expect(Math.abs(bmp.readInt32LE(22))).toBe(628)
  })
})
