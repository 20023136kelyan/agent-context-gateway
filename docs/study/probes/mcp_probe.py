import asyncio,time,sys,shutil
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
async def main():
    p=StdioServerParameters(command=sys.executable,args=["-m","graphify.serve","bf/graphify-out/graph.json"])
    async with stdio_client(p) as (r,w):
        async with ClientSession(r,w) as s:
            t=time.time();await s.initialize();print('init',round(time.time()-t,3))
            tl=await s.list_tools();print('tools',[x.name for x in tl.tools])
            rs=await s.list_resources();print('resources',[str(x.uri) for x in rs.resources])
            for name,args in [("get_node",{"label":"SearchService"}),("get_neighbors",{"label":"rrfScore()","token_budget":300}),("query_graph",{"question":"temporal invalidation","token_budget":300}),("get_node",{"label":"src/search/search.ts"})]:
                t=time.time();res=await s.call_tool(name,args);dt=time.time()-t
                txt=res.content[0].text;print(f'== {name} {args} {dt*1000:.0f}ms {len(txt)} chars');print(txt[:700])
            # hot reload: append a node by copying a newer graph
            shutil.copy('g0.json','bf/graphify-out/graph.json')
            t=time.time();res=await s.call_tool("graph_stats",{});print('after swap',round((time.time()-t)*1000),'ms',res.content[0].text[:200])
            shutil.copy('g4.json','bf/graphify-out/graph.json')
asyncio.run(main())
