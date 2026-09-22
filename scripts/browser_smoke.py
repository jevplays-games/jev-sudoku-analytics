#!/usr/bin/env python3
"""End-to-end Chromium checks. Requires Python Playwright; never calls paid JEV."""
from __future__ import annotations
import json, os, shutil, socket, subprocess, tempfile, time, urllib.request, urllib.error, http.cookiejar, re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / 'reports'
REPORTS.mkdir(exist_ok=True)

def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

BRIDGE_MODE = False
BRIDGED_PAGES = set()

def mount_test_page(page, base: str, force_bridge: bool = False) -> None:
    """Use in-memory assets + a localhost HTTP bridge where managed Chromium blocks navigation.

    This fallback does not modify browser policies. It tests the real app DOM and
    real Node HTTP handlers, but simulates EventSource with state polling. Native
    browser networking, cookies, CSP enforcement and SSE still need deployment QA.
    """
    global BRIDGE_MODE
    if not (force_bridge or BRIDGE_MODE):
        try:
            page.goto(base)
            return
        except Exception as exc:
            if 'ERR_BLOCKED_BY_ADMINISTRATOR' not in str(exc):
                raise
            BRIDGE_MODE = True
    saved = {}
    try: saved = page.evaluate('Object.fromEntries(window.__testLocalStorage || [])')
    except Exception: pass
    if page not in BRIDGED_PAGES:
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        def bridge(request):
            path = request['path']
            if not path.startswith('/api/'):
                raise ValueError('Test bridge only permits the local application API')
            method = request.get('method', 'GET')
            headers = request.get('headers', {})
            if method != 'GET': headers['Origin'] = base
            body = request.get('body')
            req = urllib.request.Request(base + path, method=method, headers=headers,
                                         data=body.encode() if body is not None else None)
            try:
                with opener.open(req, timeout=20) as response:
                    return {'status':response.status, 'body':response.read().decode(), 'headers':dict(response.headers)}
            except urllib.error.HTTPError as response:
                return {'status':response.code, 'body':response.read().decode(), 'headers':dict(response.headers)}
        page.expose_function('__testHttpBridge', bridge)
        BRIDGED_PAGES.add(page)
    page.goto('about:blank')
    html = (ROOT/'public/index.html').read_text()
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.S)
    html = re.sub(r'<link[^>]+rel="stylesheet"[^>]*>', '', html)
    page.set_content(html)
    page.add_style_tag(content=(ROOT/'public/brand/brand.css').read_text())
    page.add_style_tag(content=(ROOT/'public/game.css').read_text())
    page.evaluate(r"""saved => {
      const local = new Map(Object.entries(saved)); window.__testLocalStorage = local;
      const storage = map => ({getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),clear:()=>map.clear()});
      Object.defineProperty(window,'localStorage',{value:storage(local),configurable:true});
      Object.defineProperty(window,'sessionStorage',{value:storage(new Map()),configurable:true});
      if(!crypto.randomUUID) Object.defineProperty(crypto,'randomUUID',{value:()=>{
        const a=crypto.getRandomValues(new Uint8Array(16));a[6]=(a[6]&15)|64;a[8]=(a[8]&63)|128;
        const h=[...a].map(x=>x.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
      }});
      window.fetch=async (path,options={})=>{const r=await window.__testHttpBridge({path:String(path),method:options.method||'GET',headers:options.headers||{},body:options.body??null});return new Response(r.body,{status:r.status,headers:r.headers});};
      window.EventSource=class {
        constructor(path){this.path=path.replace(/\/events$/,'');this.handlers={};this.closed=false;this.timer=setInterval(()=>this.poll(),250);setTimeout(()=>{this.onopen?.();this.poll();},10);}
        addEventListener(name,fn){this.handlers[name]=fn;}
        async poll(){if(this.closed)return;try{const r=await fetch(this.path);if(!r.ok)throw Error();const data=await r.json();if(!this.closed)this.handlers.state?.({data:JSON.stringify(data)});}catch{if(!this.closed)this.onerror?.();}}
        close(){this.closed=true;clearInterval(this.timer);}
      };
    }""", saved)
    sources = {}
    for file in (ROOT/'shared').glob('*.js'): sources['/shared/'+file.name]=file.read_text()
    for name in ['game.js','analytics-ui.js']: sources['/'+name]=(ROOT/'public'/name).read_text()
    sources['/brand/brand.js']=(ROOT/'public/brand/brand.js').read_text()
    page.evaluate(r"""async sources => {
      const urls={}; const build=name=>{if(urls[name])return urls[name];let text=sources[name];
        const deps=[...text.matchAll(/(?:from\s*|import\(\s*)['"]([^'"]+)['"]/g)].map(m=>m[1]);
        for(const dep of new Set(deps)){
          const absolute=dep.startsWith('/')?dep:new URL(dep,'https://test.invalid'+name).pathname;
          if(!sources[absolute])throw Error('Unknown local test module '+absolute);
          const url=build(absolute);text=text.split("'"+dep+"'").join("'"+url+"'").split('"'+dep+'"').join('"'+url+'"');
        }
        return urls[name]=URL.createObjectURL(new Blob([text],{type:'text/javascript'}));
      };const brand=build('/brand/brand.js');const main=build('/game.js');window.__testModules=urls;await import(brand);await import(main);
    }""", sources)

def run() -> None:
    port = free_port()
    base = f'http://127.0.0.1:{port}'
    checks: list[str] = []
    errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix='jev-browser-') as tmp:
        env = {**os.environ, 'PORT':str(port), 'HOST':'127.0.0.1', 'APP_ORIGIN':base,
               'DATABASE_PATH':str(Path(tmp)/'test.sqlite'), 'TYPESAFE_API_KEY':'',
               'DISCORD_CLIENT_ID':'', 'DISCORD_CLIENT_SECRET':'', 'NODE_ENV':'test',
               'LAUNCH_SIGNING_KEY':'browser-test-only-not-a-secret-000000000000',
               'PRACTICE_PACING_MS':'250'}
        log = (REPORTS/'browser-server.log').open('w', encoding='utf-8')
        process = subprocess.Popen(['node', 'server/server.js'], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base+'/healthz', timeout=1) as response:
                        if response.status == 200: break
                except Exception: time.sleep(.1)
            else: raise RuntimeError('Test server did not start')
            with sync_playwright() as pw:
                executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
                browser = pw.chromium.launch(headless=True, **({'executable_path':executable} if executable else {}), args=['--no-sandbox'])
                context = browser.new_context(viewport={'width':1440,'height':1100}, reduced_motion='reduce')
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                mount_test_page(page, base)
                expect(page.locator('#connection-label')).to_have_text('Connected')
                expect(page.locator('#human-board .cell')).to_have_count(81)
                expect(page.locator('#jev-board .cell')).to_have_count(81)
                expect(page.locator('#opponent-name')).to_have_text('Local heuristic')
                checks.append('Initial load, 162 board cells, honest local-opponent label')
                page.locator('#new-game').click()
                expect(page.locator('#phase-label')).to_have_text('RACE IN PROGRESS', timeout=15000)
                board = page.evaluate("""async () => {
                    const me = await (await fetch('/api/me')).json();
                    return await (await fetch('/api/matches/'+me.activeMatch.id)).json();
                }""")
                match_id = board['id']
                solution = page.evaluate("""async (givens) => {
                    const m=await import(window.__testModules?.['/shared/sudoku.js'] || '/shared/sudoku.js'); return m.countSolutions(givens).solution;
                }""", board['givens'])
                blanks = [i for i,v in enumerate(board['givens']) if not v]
                cell = page.locator(f'#human-board [data-cell="{blanks[0]}"]')
                cell.click()
                cell.press('n')
                cell.press(str(solution[blanks[0]]))
                expect(cell.locator('.notes-grid')).to_have_count(1)
                expect(page.locator('#notes')).to_have_attribute('aria-pressed','true')
                cell.press('n')
                cell.press(str(solution[blanks[0]]))
                expect(cell).to_have_text(str(solution[blanks[0]]))
                page.locator('#undo').click()
                expect(cell).to_have_text('')
                checks.append('Keyboard notes, digit entry, server acknowledgement and undo')
                # Enable optional telemetry and verify its visible preference.
                page.locator('[data-view="profile"]').click()
                page.locator('#telemetry-consent').check()
                expect(page.locator('#telemetry-consent')).to_be_checked()
                page.locator('[data-view="play"]').click()
                for i in blanks[:10]:
                    c = page.locator(f'#human-board [data-cell="{i}"]')
                    c.click()
                    c.press(str(solution[i]))
                    expect(c).to_have_text(str(solution[i]))
                    expect(page.locator('#erase')).to_be_enabled()
                page.screenshot(path=str(REPORTS/'desktop-game.png'), full_page=True)
                page.locator('#analysis-button').click()
                expect(page.locator('#analytics-content .kpi')).to_have_count(4)
                expect(page.locator('#analytics-content svg')).to_have_count(1)
                expect(page.locator('.heatcell')).to_have_count(81)
                with page.expect_download() as download:
                    page.locator('#export-json').click()
                file = Path(download.value.path())
                exported = json.loads(file.read_text())
                assert exported['schemaVersion']=='analytics-v1'
                assert exported['human']['acceptedActions'] >= 12
                page.screenshot(path=str(REPORTS/'desktop-analytics.png'), full_page=True)
                checks.append('Live analytics, progress chart, 81-cell heatmap and JSON download')
                # Complete all remaining cells through real keyboard input and HTTP actions.
                page.locator('[data-view="play"]').click()
                for i in blanks[10:]:
                    c = page.locator(f'#human-board [data-cell="{i}"]')
                    c.click()
                    c.press(str(solution[i]))
                    expect(c).to_have_text(str(solution[i]))
                    if i != blanks[-1]: expect(page.locator('#erase')).to_be_enabled()
                expect(page.locator('#phase-label')).to_have_text('DUEL COMPLETE', timeout=15000)
                expect(page.locator('#result-banner')).to_be_visible()
                final = page.evaluate("async id => await (await fetch('/api/matches/'+id)).json()", match_id)
                assert final['verified'] and final['human']['finishMs'] is not None
                checks.append('Full puzzle solved through UI and replay-verified by server')
                page.locator('#replay-button').click()
                expect(page.locator('#replay-controls')).to_be_visible()
                page.locator('#replay-slider').fill('1')
                page.locator('#replay-slider').dispatch_event('input')
                expect(page.locator('#phase-label')).to_have_text('REPLAY')
                page.locator('#exit-replay').click()
                expect(page.locator('#phase-label')).to_have_text('DUEL COMPLETE')
                checks.append('Replay reconstruction, timeline scrubbing and return to live result')
                page.locator('[data-view="leaderboards"]').click()
                expect(page.locator('#leaderboard-content')).to_contain_text('No challenge has been published')
                page.locator('#leaderboard-scope').select_option('channel')
                page.locator('#load-leaderboard').click()
                expect(page.locator('#leaderboard-content')).to_contain_text('fresh personal link')
                checks.append('World empty state and unauthorized community scope handling')
                page.locator('[data-view="play"]').click()
                mount_test_page(page, base, force_bridge=True) if BRIDGE_MODE else page.reload()
                expect(page.locator('#phase-label')).to_have_text('DUEL COMPLETE')
                checks.append('Reload recovers the completed server-owned match')
                mobile = browser.new_context(viewport={'width':390,'height':844}, device_scale_factor=1, is_mobile=True, has_touch=True)
                mp = mobile.new_page()
                mp.on('pageerror', lambda error: errors.append(str(error)))
                mount_test_page(mp, base)
                expect(mp.locator('#connection-label')).to_have_text('Connected')
                mp.locator('#new-game').click()
                expect(mp.locator('#phase-label')).to_have_text('RACE IN PROGRESS', timeout=15000)
                overflow = mp.evaluate('document.documentElement.scrollWidth > window.innerWidth')
                assert not overflow, 'Mobile page overflows horizontally'
                mp.screenshot(path=str(REPORTS/'mobile-game.png'), full_page=True)
                mp.locator('#rules-footer').click()
                expect(mp.locator('#rules-dialog')).to_be_visible()
                mp.locator('#close-rules').click()
                checks.append('390px mobile layout without horizontal overflow and rules dialog')
                assert not errors, f'Browser JavaScript errors: {errors}'
                checks.append('No uncaught browser JavaScript errors')
                mobile.close(); context.close(); browser.close()
        finally:
            # Isolated temporary server/database only. No user service is terminated.
            process.kill(); process.wait(timeout=10); log.close()
    result={'suite':'Chromium end-to-end smoke','passed':len(checks),'failed':0,'checks':checks,
            'externalServices':'No real Discord or JEV calls. Browser used local heuristic.',
            'browserTransport':'Localhost Python HTTP bridge; EventSource simulated by polling; managed browser blocked URL navigation' if BRIDGE_MODE else 'Native browser HTTP and SSE',
            'screenshots':['desktop-game.png','desktop-analytics.png','mobile-game.png']}
    (REPORTS/'browser-results.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,indent=2))

if __name__=='__main__': run()
