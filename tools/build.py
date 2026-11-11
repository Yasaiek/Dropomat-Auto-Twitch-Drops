#!/usr/bin/env python3
"""Builds the repository: copies the extension, makes the ZIP, generates README files and the GitHub Pages site."""
import json, os, shutil, subprocess, sys, zipfile
sys.path.insert(0, os.path.dirname(__file__))
from strings import S, LANGS

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
EXT_SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'extension')
DOCS = os.path.join(ROOT, 'docs')
SHOT_LANGS = ['en', 'pl']
SITE = 'https://yasaiek.github.io/Dropomat-Auto-Twitch-Drops/'

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)

# 1) extension copy + zip
ext_dst = os.path.join(ROOT, 'extension')
if os.path.abspath(EXT_SRC) != ext_dst:
    shutil.rmtree(ext_dst, ignore_errors=True)
    shutil.copytree(EXT_SRC, ext_dst)
version = json.load(open(os.path.join(ext_dst, 'manifest.json'), encoding='utf-8'))['version']
zip_path = os.path.join(DOCS, 'dropomat.zip')
os.makedirs(DOCS, exist_ok=True)
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(ext_dst):
        for name in sorted(files):
            full = os.path.join(base, name)
            z.write(full, os.path.join('dropomat', os.path.relpath(full, ext_dst)))
write(os.path.join(DOCS, 'version.json'), json.dumps({'version': version}) + '\n')
write(os.path.join(DOCS, '.nojekyll'), '')

# 2) data from the extension: flags + a few interface strings for the animated demo
dump = subprocess.run(['node', '-e', '''
const fs=require('fs'),vm=require('vm');const ctx={chrome:{},navigator:{language:'en'}};vm.createContext(ctx);
for(const f of ['i18n.js','locales/a.js','locales/b.js','locales/c.js']) vm.runInContext(fs.readFileSync(process.argv[1]+'/'+f,'utf8')+';this.LOCALES=LOCALES;this.FLAGS=FLAGS;',ctx);
const keys=['pillOn','tabCamps','tabQueue','tabTracked','tabSettings','nWatching','stWatching','stPending'];const ui={};
for(const l of Object.keys(ctx.LOCALES)){ui[l]={};for(const k of keys)ui[l][k]=ctx.LOCALES[l][k];}
console.log(JSON.stringify({flags:ctx.FLAGS,ui}));''', ext_dst], capture_output=True, text=True, check=True)
data = json.loads(dump.stdout)

# 3) site
tpl = open(os.path.join(ROOT, 'tools', 'site_template.html'), encoding='utf-8').read()
site = (tpl.replace('__STRINGS__', json.dumps(S, ensure_ascii=False))
           .replace('__UI__', json.dumps(data['ui'], ensure_ascii=False))
           .replace('__LANGS__', json.dumps(LANGS, ensure_ascii=False))
           .replace('__FLAGS__', json.dumps(data['flags'], ensure_ascii=False))
           .replace('__SHOT_LANGS__', json.dumps(SHOT_LANGS))
           .replace('__VERSION__', version))
write(os.path.join(DOCS, 'index.html'), site)

# 4) README (English in the root, translations in docs/readme)
def readme(code, root):
    s = S[code]
    p = '' if root else '../'                      # path to docs/
    d = 'docs/' if root else '../'
    issues = '../../issues/new/choose' if root else '../../../../issues/new/choose'
    shots = code if code in SHOT_LANGS else 'en'
    def link(c):
        if c == 'en':
            return 'README.md' if root else '../../README.md'
        return f'docs/readme/README.{c}.md' if root else f'README.{c}.md'
    flags = ' '.join(f'<a href="{link(c)}" title="{n}"><img src="{d}flags/{c}.svg" width="24" alt="{n}"></a>' for c, n in LANGS)
    out = f'''<p align="center"><img src="{d}icon.png" width="104" alt="Dropomat"></p>
<h1 align="center">Dropomat – Auto Twitch Drops Collector</h1>
<p align="center"><b>{s["tagline"]}</b></p>
<p align="center">{flags}</p>
<p align="center">
  <a href="{d}dropomat.zip?raw=true"><b>⬇ {s["download"]} (ZIP)</b></a> &nbsp;·&nbsp;
  <a href="{SITE}"><b>🌐 Website</b></a> &nbsp;·&nbsp;
  <a href="{issues}">{s["report"]}</a> &nbsp;·&nbsp; {s["version"]} {version}
</p>
<p align="center"><img src="{d}img/hero.png" alt="Dropomat" width="860"></p>

## {s["featTitle"]}

'''
    for i in range(1, 7):
        out += f'- **{s[f"f{i}t"]}** – {s[f"f{i}"]}\n'
    out += f'''
<p align="center"><img src="{d}img/demo.gif" alt="" width="400"></p>

## {s["installTitle"]}

1. {s["i1"]}
2. {s["i2"]}
3. {s["i3"]}
4. {s["i4"]}

<p align="center"><img src="{d}img/install.png" alt="" width="820"></p>

> {s["worksIn"]}

### {s["updateTitle"]}

{s["update"]}

## {s["howTitle"]}

| {s["h1t"]} | {s["h2t"]} |
|:--:|:--:|
| <img src="{d}img/{shots}/campaigns.png" width="380" alt=""> | <img src="{d}img/{shots}/watching.png" width="380" alt=""> |
| {s["h1"]} | {s["h2"]} |

| {s["h3t"]} | {s["h4t"]} |
|:--:|:--:|
| <img src="{d}img/{shots}/tracked.png" width="380" alt=""> | <img src="{d}img/{shots}/settings.png" width="380" alt=""> |
| {s["h3"]} | {s["h4"]} |

## {s["faqTitle"]}

'''
    for i in range(1, 5):
        out += f'**{s[f"q{i}"]}**  \n{s[f"a{i}"]}\n\n'
    out += f'''## {s["bugTitle"]}

{s["bugText"]}

➡ **[{s["report"]}]({issues})**

---

<sub>{s["disclaimer"]} · MIT</sub>
'''
    return out

write(os.path.join(ROOT, 'README.md'), readme('en', True))
for code, _ in LANGS:
    if code != 'en':
        write(os.path.join(DOCS, 'readme', f'README.{code}.md'), readme(code, False))

# 5) repository housekeeping
write(os.path.join(ROOT, 'LICENSE'), '''MIT License

Copyright (c) 2026 Dropomat contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
''')
write(os.path.join(ROOT, '.gitignore'), 'tools/__pycache__/\n*.pyc\n.DS_Store\nThumbs.db\nwrzuc-na-github.bat\n')
write(os.path.join(ROOT, '.gitattributes'), '* -text\n')
write(os.path.join(ROOT, 'CHANGELOG.md'), f'''# Changelog

## {version}
- A finished drop that you already claimed is no longer shown as "to claim" after its campaign leaves your Twitch inventory.

## 1.2.2
- Drop names and icons are remembered, so they stay visible when a campaign's streams go offline or Twitch's campaign page fails to load.
- A failed read of the campaign page no longer drops campaigns from the list.

## 1.2.1
- Drop icons and names no longer go missing for campaigns you have no progress in yet (data from several Twitch sources is now combined).
- A drop without a name no longer shows a stray colon in the queue.

## 1.2.0
- Campaign list read from Twitch's own drops page plus a public scan, so campaigns no longer go missing.
- Streams are verified to really carry the game's campaign before watching.
- Interface in 12 languages with a flag picker.
- Optional auto-claim, with an account-link check and an alert instead of claiming when the link is not confirmed.
- Update check against the project site.
- New icon.

## 1.1.0
- Tabs: Campaigns, Watching, Tracked, Settings. Click campaigns to build the queue, drag to reorder.
- Game covers and drop icons with progress.

## 1.0.0
- First version: queue, automatic stream switching, tracking of new campaigns.
''')
write(os.path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'), '''name: Bug report
description: Something does not work as expected
labels: [bug]
body:
  - type: textarea
    id: what
    attributes:
      label: What happened?
      description: What did you do, what did you expect, what happened instead? You can write in your own language.
    validations:
      required: true
  - type: input
    id: game
    attributes:
      label: Game / campaign
      placeholder: e.g. War Thunder – WTCS Pro Grand Finals
  - type: textarea
    id: log
    attributes:
      label: Log
      description: Open Dropomat → Settings → Log and paste the first line ("Read …") and the last few entries.
      render: text
  - type: input
    id: browser
    attributes:
      label: Browser and version
      placeholder: e.g. Chrome 142, Opera GX 125
    validations:
      required: true
  - type: input
    id: version
    attributes:
      label: Dropomat version
      placeholder: e.g. ''' + version + '''
''')
write(os.path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'feature_request.yml'), '''name: Idea
description: Suggest an improvement
labels: [enhancement]
body:
  - type: textarea
    id: idea
    attributes:
      label: What would you like to have?
      description: Describe the idea and when it would help you. You can write in your own language.
    validations:
      required: true
''')
write(os.path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'config.yml'), 'blank_issues_enabled: true\n')
print('built', version, os.path.getsize(zip_path), 'bytes zip')
