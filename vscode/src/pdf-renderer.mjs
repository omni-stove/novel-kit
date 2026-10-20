/**
 * HTML を PDF にする（vivliostyle build の代わり）
 *
 *   node pdf-renderer.mjs <html> -o <out.pdf>
 *
 * Vivliostyle Viewer（@vivliostyle/cli が使うのと同じ版）を Chrome（同じ版・同じ起動オプション）で開き、
 * 組み終わったら page.pdf で印刷し、メタデータ・しおり・ページの寸法を vivliostyle build と同じように付ける。
 * Chrome は @vivliostyle/cli と同じキャッシュ（~/Library/Caches/vivliostyle/browsers など）を使い、無ければダウンロードする。
 * src/lib/cli.mjs の vivliostyleBuild は、環境変数 NOVEL_PDF_RENDERER にこのファイルのパスがあればこちらを呼ぶ。
 *
 * VS Code 拡張は @vivliostyle/cli（vite やネイティブモジュールを含み 200MB を超える）を同梱できないため、
 * vivliostyle build を呼ばずに同じ手順を再現する（出力は vivliostyle build とページ単位で一致することを確かめてある）。
 * @vivliostyle/cli を上げたら vscode/package.json の @vivliostyle/viewer をその依存と同じ版に合わせる（ずれるとテストが落ちる）
 */

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as browsers from '@puppeteer/browsers';
import { DEFAULT_BROWSER_VERSIONS } from '@vivliostyle/cli/constants';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, ReadingDirection } from 'pdf-lib';
import puppeteer from 'puppeteer-core';

const VIEWER_ROOT_PATH = '/__vivliostyle-viewer';
const TIMEOUT_MS = 300_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * @vivliostyle/cli と同じキャッシュディレクトリ（ブラウザのダウンロードを CLI と共有するため）。
 * macOS は ~/Library/Caches/vivliostyle、Windows は %LOCALAPPDATA%/vivliostyle、他は $XDG_CACHE_HOME（無ければ ~/.cache）/vivliostyle
 */
export function cacheDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'vivliostyle');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'vivliostyle');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'vivliostyle');
}

/** URL のパスを、配信するディレクトリ root の中のファイルに対応させる（外へ出るパス・壊れたエンコードは null） */
export function resolveServedPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const path = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep) ? path : null;
}

/** htmlName を開く Viewer の URL（vivliostyle build が HTML 1つを渡されたときと同じ指定） */
export function viewerUrl(origin, htmlName) {
  return `${origin}${VIEWER_ROOT_PATH}/index.html#src=${origin}/${encodeURIComponent(htmlName).replace(/&/g, '%26')}&bookMode=true&renderAllPages=true`;
}

/** 127.0.0.1 の空きポートで配信を始める。Viewer は /__vivliostyle-viewer/ 以下、原稿の HTML のディレクトリは / 直下 */
function startServer(viewerDir, contentDir) {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.startsWith(`${VIEWER_ROOT_PATH}/`)
      ? resolveServedPath(viewerDir, url.slice(VIEWER_ROOT_PATH.length))
      : resolveServedPath(contentDir, url);
    if (!path || !existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

/** @vivliostyle/cli と同じ版の Chrome の実行ファイルのパス。キャッシュに無ければダウンロードして展開する */
async function chromePath() {
  const platform = browsers.detectBrowserPlatform();
  if (!platform) throw new Error('この OS では PDF 出力用の Chrome を用意できません。');
  const buildId = DEFAULT_BROWSER_VERSIONS.chrome[platform];
  const dir = join(cacheDir(), 'browsers');
  const executablePath = browsers.computeExecutablePath({ cacheDir: dir, browser: browsers.Browser.CHROME, buildId });
  if (existsSync(executablePath)) return executablePath;
  console.log(`PDF 出力用の Chrome ${buildId} をダウンロードします（初回のみ・約180MB）…`);
  let lastPercent = -1;
  // 展開は @puppeteer/browsers に任せない（その extract-zip は Node 26 で止まったまま終わらない）
  const archivePath = await browsers.install({
    cacheDir: dir,
    browser: browsers.Browser.CHROME,
    buildId,
    unpack: false,
    downloadProgressCallback: (downloaded, total) => {
      const percent = total ? Math.floor((downloaded / total) * 10) * 10 : 0;
      if (percent !== lastPercent) console.log(`  ${percent}%`);
      lastPercent = percent;
    },
  });
  console.log('展開しています…');
  const installDir = join(dir, browsers.Browser.CHROME, `${platform}-${buildId}`);
  const tmpDir = `${installDir}.tmp-${process.pid}`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    unzip(archivePath, tmpDir);
    // 途中で止まったときに中途半端なフォルダが残らないよう、展開しきってから置く
    rmSync(installDir, { recursive: true, force: true });
    renameSync(tmpDir, installDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(archivePath, { force: true });
  }
  // 展開済みのフォルダがあれば、install はダウンロードせずに後の設定（Windows のサンドボックスなど）だけを行う
  return (await browsers.install({ cacheDir: dir, browser: browsers.Browser.CHROME, buildId })).executablePath;
}

// .app の中のシンボリックリンクや実行権限を保つため、OS の展開コマンドを使う
function unzip(archivePath, dest) {
  if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', archivePath, dest]);
  else if (process.platform === 'win32') execFileSync('tar', ['-xf', archivePath, '-C', dest]);
  else execFileSync('unzip', ['-q', archivePath, '-d', dest]);
}

// vivliostyle の launchBrowser（Chrome・ヘッドレス）と同じ起動オプション
function chromeArgs() {
  const args = [
    '--disable-field-trial-config',
    '--disable-back-forward-cache',
    '--disable-component-update',
    '--no-default-browser-check',
    '--disable-features=AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument',
    '--enable-features=CDPScreenshotNewSurface',
    '--no-service-autorun',
    '--unsafely-disable-devtools-self-xss-warnings',
    '--edge-skip-compat-layer-relaunch',
  ];
  if (process.platform === 'darwin') args.push('--enable-unsafe-swiftshader');
  args.push(
    '--hide-scrollbars',
    '--mute-audio',
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
    '--disable-web-security',
    '--force-device-scale-factor=1',
    '--lang=en',
    '--no-startup-window',
  );
  return args;
}

// 以下の後処理は vivliostyle の PostProcess に合わせる

const DCTERMS = 'http://purl.org/dc/terms/';
const META = 'http://idpf.org/epub/vocab/package/meta/#';

function applyMetadata(pdf, tree, { pageProgression, browserVersion, viewerCoreVersion }) {
  const title = tree[`${DCTERMS}title`]?.[0].v;
  if (title) pdf.setTitle(title);
  const author = tree[`${DCTERMS}creator`]?.map((item) => item.v)?.join('; ');
  if (author) pdf.setAuthor(author);
  const subject = tree[`${DCTERMS}description`]?.[0].v;
  if (subject) pdf.setSubject(subject);
  const keywords = tree[`${DCTERMS}subject`]?.map((item) => item.v);
  if (keywords) pdf.setKeywords(keywords);
  pdf.setCreator(`Vivliostyle (Vivliostyle.js ${viewerCoreVersion}; ${browserVersion})`);
  const language = tree[`${DCTERMS}language`]?.[0].v;
  if (language) pdf.setLanguage(language);
  const creation = (tree[`${META}created`] || tree[`${META}date`])?.[0].v;
  if (creation) pdf.setCreationDate(new Date(creation));
  if (pageProgression === 'rtl') pdf.catalog.getOrCreateViewerPreferences().setReadingDirection(ReadingDirection.R2L);
}

function applyToc(pdf, items) {
  if (!items?.length) return;
  const addRefs = (list, parentRef) =>
    list.map((item) => {
      const ref = pdf.context.nextRef();
      return { ...item, parentRef, ref, children: addRefs(item.children, ref) };
    });
  const countAll = (list) => list.reduce((sum, item) => sum + countAll(item.children), list.length);
  const addObjects = (list) => {
    for (const [i, item] of list.entries()) {
      const dict = PDFDict.withContext(pdf.context);
      dict.set(PDFName.of('Title'), PDFHexString.fromText(item.title));
      dict.set(PDFName.of('Dest'), PDFName.of(item.id));
      dict.set(PDFName.of('Parent'), item.parentRef);
      if (list[i - 1]) dict.set(PDFName.of('Prev'), list[i - 1].ref);
      if (list[i + 1]) dict.set(PDFName.of('Next'), list[i + 1].ref);
      if (item.children.length) {
        dict.set(PDFName.of('First'), item.children[0].ref);
        dict.set(PDFName.of('Last'), item.children[item.children.length - 1].ref);
        dict.set(PDFName.of('Count'), PDFNumber.of(countAll(item.children)));
      }
      pdf.context.assign(item.ref, dict);
      addObjects(item.children);
    }
  };
  const outlineRef = pdf.context.nextRef();
  const withRefs = addRefs(items, outlineRef);
  addObjects(withRefs);
  const outline = PDFDict.withContext(pdf.context);
  outline.set(PDFName.of('First'), withRefs[0].ref);
  outline.set(PDFName.of('Last'), withRefs[withRefs.length - 1].ref);
  outline.set(PDFName.of('Count'), PDFNumber.of(countAll(withRefs)));
  pdf.context.assign(outlineRef, outline);
  pdf.catalog.set(PDFName.of('Outlines'), outlineRef);
}

// Chrome は用紙を大きめに出すので、Viewer が組んだページの寸法に合わせる（末尾に出る白紙も除く）
function applyPageBoxes(pdf, sizes) {
  if (sizes.length + 1 === pdf.getPageCount()) pdf.removePage(sizes.length);
  if (sizes.length !== pdf.getPageCount()) return;
  sizes.forEach((size, i) => {
    const page = pdf.getPage(i);
    if (!size.mediaWidth || !size.mediaHeight || Number.isNaN(size.bleedOffset) || Number.isNaN(size.bleedSize)) return;
    const yOffset = page.getHeight() - size.mediaHeight;
    page.setMediaBox(0, yOffset, size.mediaWidth, size.mediaHeight);
    if (!size.bleedOffset && !size.bleedSize) return;
    page.setBleedBox(
      size.bleedOffset,
      yOffset + size.bleedOffset,
      size.mediaWidth - size.bleedOffset * 2,
      size.mediaHeight - size.bleedOffset * 2,
    );
    const trim = size.bleedOffset + size.bleedSize;
    page.setTrimBox(trim, yOffset + trim, size.mediaWidth - trim * 2, size.mediaHeight - trim * 2);
  });
}

/** htmlPath を Viewer で組んで outputPath に PDF を書き出す。viewerDir は Vivliostyle Viewer の lib ディレクトリ */
export async function renderPdf(htmlPath, outputPath, { viewerDir }) {
  const server = await startServer(viewerDir, dirname(resolve(htmlPath)));
  let browser;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({
      executablePath: await chromePath(),
      args: chromeArgs(),
      browser: 'chrome',
      headless: true,
      waitForInitialPage: false,
      protocolTimeout: TIMEOUT_MS,
      env: { ...process.env, LANG: 'en.UTF-8' },
    });
    const [context] = browser.browserContexts();
    const page = (await context.pages())[0] ?? (await context.newPage());
    // Viewer はこの大きさでヘッドレスかどうかを見分ける
    await page.setViewport({ width: 800, height: 600 });
    page.setDefaultTimeout(TIMEOUT_MS);
    page.on('pageerror', (error) => console.error(error.message));
    page.on('dialog', () => {});
    await page.goto(viewerUrl(origin, basename(htmlPath)));

    await page.waitForNetworkIdle();
    await page.waitForFunction(() => !!window.coreViewer);
    await page.emulateMediaType('print');
    await page.waitForFunction(() => window.coreViewer.readyState === 'complete', { polling: 1000 });

    const browserVersion = await browser.version();
    const pageProgression = await page.evaluate(() =>
      document.querySelector('#vivliostyle-viewer-viewport')?.getAttribute('data-vivliostyle-page-progression') ===
      'rtl'
        ? 'rtl'
        : 'ltr',
    );
    const viewerCoreVersion = await page.evaluate(() =>
      document
        .querySelector('#vivliostyle-menu_settings .version')
        ?.textContent?.replace(/^.*?: (\d[-+.\w]+).*$/, '$1'),
    );
    const metadata = await page.evaluate(() => window.coreViewer.getMetadata());
    const toc = await page.evaluate(
      () =>
        new Promise((done) => {
          function listener(payload) {
            if (payload.a !== 'toc') return;
            window.coreViewer.removeListener('done', listener);
            window.coreViewer.showTOC(false);
            done(window.coreViewer.getTOC());
          }
          window.coreViewer.addListener('done', listener);
          window.coreViewer.showTOC(true);
        }),
    );
    const pageSizes = await page.evaluate(() =>
      [
        ...document.querySelectorAll('#vivliostyle-viewer-viewport > div > div > div[data-vivliostyle-page-container]'),
      ].map((container) => {
        const bleedBox = container.querySelector('div[data-vivliostyle-bleed-box]');
        return {
          mediaWidth: parseFloat(container.style.width) * 0.75,
          mediaHeight: parseFloat(container.style.height) * 0.75,
          bleedOffset: parseFloat(bleedBox?.style.left) * 0.75,
          bleedSize: parseFloat(bleedBox?.style.paddingLeft) * 0.75,
        };
      }),
    );

    const printed = await page.pdf({
      margin: { top: 0, bottom: 0, right: 0, left: 0 },
      printBackground: true,
      tagged: true,
      preferCSSPageSize: true,
    });
    await browser.close();
    browser = null;

    const pdf = await PDFDocument.load(printed, { updateMetadata: false });
    applyMetadata(pdf, metadata, { pageProgression, browserVersion, viewerCoreVersion });
    applyToc(pdf, toc);
    applyPageBoxes(pdf, pageSizes);
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    writeFileSync(outputPath, await pdf.save());
  } finally {
    await browser?.close();
    server.close();
  }
}

// 拡張では CommonJS に bundle して dist/ に置くので __filename、開発中は import.meta.url
const thisFile = () => (typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url));

// 拡張の dist/ では Viewer を dist/viewer に置く。開発中は node_modules のものを使う
function defaultViewerDir() {
  const bundled = join(dirname(thisFile()), 'viewer');
  if (existsSync(join(bundled, 'index.html'))) return bundled;
  return join(dirname(createRequire(thisFile()).resolve('@vivliostyle/viewer/package.json')), 'lib');
}

/** コマンドライン引数 <html> -o|--output <out.pdf>（順不同）を { input, output } にする。足りなければ使い方のエラー */
export function parseArgs(argv) {
  const outIndex = argv.findIndex((a) => a === '-o' || a === '--output');
  const output = outIndex >= 0 ? argv[outIndex + 1] : null;
  const input = argv.find((_a, i) => i !== outIndex && i !== outIndex + 1);
  if (!input || !output) throw new Error('使い方: pdf-renderer <html> -o <out.pdf>');
  return { input, output };
}

export async function main(argv = process.argv.slice(2)) {
  const { input, output } = parseArgs(argv);
  if (!existsSync(input)) throw new Error(`${input} が見つかりません`);
  await renderPdf(input, output, { viewerDir: defaultViewerDir() });
}

if (process.argv[1] && resolve(process.argv[1]) === thisFile()) {
  main().catch((err) => {
    console.error('エラー:', err.message);
    process.exit(1);
  });
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('cacheDir', () => {
    test('@vivliostyle/cli と同じ場所', () => {
      expect(cacheDir('darwin', {}, '/Users/a')).toBe('/Users/a/Library/Caches/vivliostyle');
      expect(cacheDir('linux', {}, '/home/a')).toBe('/home/a/.cache/vivliostyle');
      expect(cacheDir('linux', { XDG_CACHE_HOME: '/x' }, '/home/a')).toBe('/x/vivliostyle');
    });
  });

  describe('resolveServedPath', () => {
    test('配信するディレクトリの中だけを返す', () => {
      expect(resolveServedPath('/srv', '/a/b.html?x=1')).toBe('/srv/a/b.html');
      expect(resolveServedPath('/srv', '/%E5%8E%9F%E7%A8%BF.html')).toBe('/srv/原稿.html');
      expect(resolveServedPath('/srv', '/../etc/passwd')).toBeNull();
      expect(resolveServedPath('/srv', '/%2e%2e/secret')).toBeNull();
      expect(resolveServedPath('/srv', '/%E0%A4%A')).toBeNull();
    });
  });

  describe('依存の版', () => {
    test('Viewer は @vivliostyle/cli が使うのと同じ版（CLI を上げたら vscode/package.json の @vivliostyle/viewer も合わせる）', async () => {
      const { readFileSync } = await import('node:fs');
      const readPackage = (from, name) =>
        JSON.parse(readFileSync(createRequire(from).resolve(`${name}/package.json`), 'utf-8'));
      const viewer = readPackage(thisFile(), '@vivliostyle/viewer');
      // @vivliostyle/cli はリポジトリ直下の依存
      const cli = readPackage(resolve(dirname(thisFile()), '../../package.json'), '@vivliostyle/cli');
      expect(viewer.version).toBe(cli.dependencies['@vivliostyle/viewer']);
    });
  });

  describe('parseArgs', () => {
    test('<html> -o <out.pdf> を受け取り、順番は問わない', () => {
      expect(parseArgs(['a.html', '-o', 'out.pdf'])).toEqual({ input: 'a.html', output: 'out.pdf' });
      expect(parseArgs(['--output', 'out.pdf', 'a.html'])).toEqual({ input: 'a.html', output: 'out.pdf' });
    });
    test('入力か出力が無ければ使い方のエラー', () => {
      expect(() => parseArgs(['a.html'])).toThrow('使い方');
      expect(() => parseArgs(['-o', 'out.pdf'])).toThrow('使い方');
    });
  });

  describe('viewerUrl', () => {
    test('vivliostyle build と同じ指定で、ファイル名はエンコードする', () => {
      expect(viewerUrl('http://127.0.0.1:1', 'a b&c.html')).toBe(
        'http://127.0.0.1:1/__vivliostyle-viewer/index.html#src=http://127.0.0.1:1/a%20b%26c.html&bookMode=true&renderAllPages=true',
      );
    });
  });
}
