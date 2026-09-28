import asyncio,sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
async def main():
    p=StdioServerParameters(command=sys.executable,args=["-m","graphify.serve","bf/graphify-out/graph.json"])
    async with stdio_client(p) as (r,w):
        async with ClientSession(r,w) as s:
            await s.initialize()
            for n,a in [("query_graph",{"question":"rrfScore","token_budget":250}),("get_node",{"label":"rrfScore()"}),("get_neighbors",{"label":"ranking.ts","token_budget":250})]:
                res=await s.call_tool(n,a);print('==',n);print(res.content[0].text[:900])
asyncio.run(main())
