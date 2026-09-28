import json,sys,collections as C
a=json.load(open(sys.argv[1]));b=json.load(open(sys.argv[2]))
A={n['id']:n for n in a['nodes']};B={n['id']:n for n in b['nodes']}
add=set(B)-set(A);rem=set(A)-set(B)
print('nodes',len(A),'->',len(B),'added',len(add),'removed',len(rem))
print(' added by file',C.Counter(B[i].get('source_file') for i in add).most_common(8))
print(' removed by file',C.Counter(A[i].get('source_file') for i in rem).most_common(8))
for i in sorted(rem)[:12]: print('  -',i,A[i].get('label'),A[i].get('source_location'))
for i in sorted(add)[:12]: print('  +',i,B[i].get('label'),B[i].get('source_location'))
common=set(A)&set(B)
loc=[i for i in common if A[i].get('source_location')!=B[i].get('source_location')]
com=[i for i in common if A[i].get('community')!=B[i].get('community')]
print('loc changed',len(loc),C.Counter(B[i].get('source_file') for i in loc).most_common(4))
print('community changed',len(com),'of',len(common))
ea={(l['source'],l['target'],l['relation']) for l in a['links']};eb={(l['source'],l['target'],l['relation']) for l in b['links']}
print('edges',len(ea),'->',len(eb),'added',len(eb-ea),'removed',len(ea-eb))
