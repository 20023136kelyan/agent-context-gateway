import asyncio, hashlib, math, time, re, json, collections
from datetime import datetime, timezone, timedelta
from graphiti_core import Graphiti
from graphiti_core.driver.kuzu_driver import KuzuDriver
from graphiti_core.llm_client.client import LLMClient
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.embedder.client import EmbedderClient
from graphiti_core.cross_encoder.client import CrossEncoderClient
from graphiti_core.nodes import EntityNode
from graphiti_core.edges import EntityEdge
from graphiti_core.search.search_filters import SearchFilters, DateFilter, ComparisonOperator

CALLS = collections.Counter()
class FakeLLM(LLMClient):
    """Scripted stand-in: records every prompt the pipeline sends; answers 'second fact contradicts first'."""
    async def _generate_response(self, messages, response_model=None, max_tokens=0, model_size=None):
        name = response_model.__name__ if response_model else 'none'
        CALLS[name] += 1
        if name == 'EdgeDuplicate':
            open('edgedup_prompt.txt','w').write('\n=====\n'.join(m.role+': '+m.content for m in messages))
            txt = messages[-1].content
            # contradict any existing fact that mentions 'retry' when the new one says 'reverted'
            idx = [int(m) for m in re.findall(r"'idx': (\d+), 'fact': '[^']*retry", txt)]
            return {'duplicate_facts': [], 'contradicted_facts': idx if 'reverted' in txt.split('<NEW FACT>')[-1].split('</NEW FACT>')[0] else []}
        return {}
class HashEmbed(EmbedderClient):
    async def create(self, input_data):
        v=[0.0]*64
        for w in re.findall(r'\w+', str(input_data).lower()):
            v[int(hashlib.md5(w.encode()).hexdigest(),16)%64]+=1
        n=math.sqrt(sum(x*x for x in v)) or 1; return [x/n for x in v]
    async def create_batch(self, xs): return [await self.create(x) for x in xs]
class NoRerank(CrossEncoderClient):
    async def rank(self, q, ps): return [(p,1.0) for p in ps]

async def main():
    drv = KuzuDriver(db=':memory:')
    g = Graphiti(graph_driver=drv, llm_client=FakeLLM(LLMConfig(api_key='x')), embedder=HashEmbed(), cross_encoder=NoRerank())
    await g.build_indices_and_constraints()
    # Kuzu driver never creates its FTS indexes (build_indices is a no-op); do it by hand
    import kuzu
    from graphiti_core.graph_queries import get_fulltext_indices
    from graphiti_core.driver.driver import GraphProvider
    await drv.execute_query('INSTALL fts; LOAD fts;')
    for q in get_fulltext_indices(GraphProvider.KUZU): await drv.execute_query(q)
    gid='repo_bifrost'
    f = EntityNode(name='src/auth/refresh.ts', group_id=gid, labels=['File'], summary='')
    s = EntityNode(name='refreshSession', group_id=gid, labels=['Symbol'], summary='')
    t0=datetime(2026,9,20,tzinfo=timezone.utc)
    e1 = EntityEdge(group_id=gid, source_node_uuid=f.uuid, target_node_uuid=s.uuid, name='WARNING',
         fact='Adding a retry inside refreshSession loops forever on 401 responses', created_at=t0, valid_at=t0)
    t=time.time(); r1 = await g.add_triplet(f, e1, s); print('triplet1', round((time.time()-t)*1000),'ms', dict(CALLS))
    t1=t0+timedelta(days=3)
    e2 = EntityEdge(group_id=gid, source_node_uuid=f.uuid, target_node_uuid=s.uuid, name='DECISION',
         fact='The retry in refreshSession was reverted in a1b2c3d; refresh now fails fast', created_at=t1, valid_at=t1)
    t=time.time(); r2 = await g.add_triplet(f, e2, s); print('triplet2', round((time.time()-t)*1000),'ms', dict(CALLS))
    print('invalidated by triplet2:', [(e.fact[:40], e.invalid_at, e.expired_at is not None) for e in r2.edges[1:]])
    res = await g.search('refreshSession retry 401', group_ids=[gid])
    print('default search returns', [(e.name, e.fact[:45], 'INVALID' if e.invalid_at else 'valid') for e in res])
    only_valid = SearchFilters(invalid_at=[[DateFilter(comparison_operator=ComparisonOperator.is_null)]])
    res = await g.search('refreshSession retry 401', group_ids=[gid], search_filter=only_valid)
    print('with invalid_at IS NULL filter', [(e.name, e.fact[:45]) for e in res])
    res = await g.search('refreshSession', group_ids=[gid], center_node_uuid=s.uuid)
    print('centered on symbol', [(e.name) for e in res])
    print('LLM calls by response model', dict(CALLS))
asyncio.run(main())
