import json,re,html,sys
d=json.load(open('out.json'))
o=d.get('out',''); m=re.search(r'<body[^>]*>(.*)',o,re.S)
print('OUT',html.unescape(re.sub(r'<[^>]+>',' ',m.group(1) if m else o)).strip()[:1200])
print('ERR',d.get('errors','')[:800]); dd=d['d1']; print('ms',d.get('ms'),'calls',dd['calls'],'d1ms',dd['ms'],'failures',len(dd['failures']))
seen=set()
for f in dd['failures']:
    k=f['error'][:90]
    if k in seen: continue
    seen.add(k); print(' -',f['error'][:170],'|',f['sql'][:260].replace(chr(10),' '))
