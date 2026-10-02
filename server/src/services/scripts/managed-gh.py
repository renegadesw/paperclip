#!/usr/bin/env python3
"""Select an already-authorized App installation for each gh invocation."""
import base64, json, os, re, subprocess, sys
args = sys.argv[1:]
bundle = os.environ.get('PAPERCLIP_GIT_TOKEN', '')
if bundle.startswith('vgit1.'):
    try:
        owner = ''
        for i, arg in enumerate(args):
            if arg in ('-R', '--repo') and i+1 < len(args):
                owner = args[i+1].split('/')[0]
            elif arg.startswith('--repo='):
                owner = arg.split('=',1)[1].split('/')[0]
            elif re.match(r'^/?repos/[^/]+/',arg):
                owner = arg.strip('/').split('/')[1]
            elif re.match(r'^https://github\.com/[^/]+/',arg):
                owner = arg.split('/')[3]
            elif len(args)>1 and args[0]=='repo' and '/' in arg and not arg.startswith('-'):
                owner = arg.split('/')[0]
        if not owner:
            p = subprocess.run(['git','remote','get-url','origin'],capture_output=True,text=True)
            m = re.search(r'github\.com[:/]([^/]+)/',p.stdout)
            if m: owner=m.group(1)
        raw = bundle[6:]
        rows = json.loads(base64.urlsafe_b64decode(raw + '='*((-len(raw))%4)))
        selected = next((r for r in rows if r['owner'].lower()==owner.lower()),None) if owner else rows[0]
        if not selected: raise ValueError()
        os.environ['GH_TOKEN']=selected['token']
        os.environ['GITHUB_TOKEN']=selected['token']
    except Exception:
        sys.exit('GitHub App credentials are unavailable for this repository owner')
os.execve('/usr/bin/gh', ['/usr/bin/gh']+args, os.environ)
