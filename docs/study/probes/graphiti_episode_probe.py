import asyncio, typing, collections, time, json
from datetime import datetime, timezone
exec(open('graphiti_triplet_probe.py').read().split('async def main')[0])  # reuse fakes
PROMPTS=collections.Counter()
class ScriptedLLM(LLMClient):
    async def _generate_response(self, messages, response_model=None, max_tokens=0, model_size=None):
        name=response_model.__name__ if response_model else 'none'; PROMPTS[name]+=1
        if name=='ExtractedEntities':
            return {'extracted_entities':[{'name':'refreshSession','entity_type_id':0},{'name':'src/auth/refresh.ts','entity_type_id':0},{'name':'401 responses','entity_type_id':0}]}
        if name=='ExtractedEdges':
            return {'edges':[{'source_entity_name':'refreshSession','target_entity_name':'401 responses','relation_type':'LOOPS_ON','fact':'A retry inside refreshSession loops forever on 401 responses','valid_at':None,'invalid_at':None}]}
        # generic empty answer shaped by the schema
        out={}
        for f,info in response_model.model_fields.items():
            a=info.annotation; o=typing.get_origin(a)
            out[f]=[] if (o is list or a is list) else ('' if a is str else None)
        return out
async def main():
    drv=KuzuDriver(db=':memory:'); drv._database='repo_bifrost'
    g=Graphiti(graph_driver=drv,llm_client=ScriptedLLM(LLMConfig(api_key='x')),embedder=HashEmbed(),cross_encoder=NoRerank())
    from graphiti_core.graph_queries import get_fulltext_indices
    from graphiti_core.driver.driver import GraphProvider
    await drv.execute_query('INSTALL fts; LOAD fts;')
    for q in get_fulltext_indices(GraphProvider.KUZU): await drv.execute_query(q)
    body='claude-code session 7f3: tried adding a retry inside refreshSession in src/auth/refresh.ts; it loops forever on 401 responses, so it was reverted.'
    for i in range(2):
        PROMPTS.clear(); t=time.time()
        r=await g.add_episode(name=f'session-{i}',episode_body=body,source_description='agent session',reference_time=datetime.now(timezone.utc),group_id='repo_bifrost')
        print(f'episode {i}: {round((time.time()-t)*1000)} ms (fake LLM), nodes={len(r.nodes)} edges={len(r.edges)} LLM calls={sum(PROMPTS.values())} {dict(PROMPTS)}')
asyncio.run(main())
