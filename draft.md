# Teaching LLMs About Smithy: Building an MCP Server with Bedrock Knowledge Bases

We've all been there — you're trying to explain Smithy syntax to Claude, and it confidently generates something that looks right but is completely wrong. You paste in documentation. It forgets. You paste in more documentation. You hit context limits. You start over.

This is exactly the problem [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) was designed to solve. MCP is an open standard that lets applications provide context to LLMs through a standardized interface — think of it as a USB port for AI context. Instead of cramming documentation into prompts, you give the LLM tools to search and retrieve exactly what it needs, when it needs it.

But here's the thing: most MCP servers just wrap APIs or file systems. What if your documentation is large, constantly evolving, and needs semantic understanding? That's where AWS Bedrock Knowledge Bases come in.

## Why Smithy Needs This

If you haven't used [Smithy](https://smithy.io/), it's a language for defining APIs and data schemas that generates server code, client SDKs, and OpenAPI specs from a single source of truth. It's fantastic for teams working across multiple languages — define your API once in Smithy, generate TypeScript clients and Java servers automatically. It forces contract-first design, letting frontend and backend teams work in parallel without waiting on each other.

The problem? Smithy has a lot of syntax, a lot of traits, and a lot of interconnected concepts. LLMs trained on general web data don't have deep Smithy knowledge, and the documentation is too large to fit in a context window alongside your actual work.

## The Architecture

Here's what I built:

```
Smithy Docs (GitHub) → Ingestion Script → S3 → Bedrock Knowledge Base → Lambda (MCP Server) → Claude
```

The flow is straightforward:
1. Clone Smithy docs from GitHub and convert them to markdown
2. Upload to S3
3. Bedrock Knowledge Base ingests the docs and creates vector embeddings
4. Lambda function exposes MCP tools that query the Knowledge Base
5. Claude (or any MCP client) can now semantically search Smithy documentation

### What's a Bedrock Knowledge Base?

Bedrock Knowledge Bases are AWS's managed RAG (Retrieval Augmented Generation) solution. You point them at documents in S3, they automatically chunk and embed the content, and store vectors in your choice of vector database. When you query, they retrieve relevant chunks and can optionally use an LLM to synthesize answers.

The key advantage: you don't manage embeddings, chunking strategies, or vector databases yourself. It's serverless, scales automatically, and costs about $5/month for a documentation set like Smithy's (using S3 for vector storage instead of OpenSearch Serverless).

I had to create the Knowledge Base manually since CDK constructs don't exist yet, but the setup is simple through the console.

## The MCP Tools

The server exposes three tools to Claude:

**search_smithy_docs** — Semantic search across all documentation
```json
{
  "name": "search_smithy_docs",
  "description": "Search Smithy documentation using semantic search",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query"
      },
      "max_results": {
        "type": "number",
        "description": "Maximum results (1-10, default: 5)"
      }
    },
    "required": ["query"]
  }
}
```

**read_smithy_doc** — Read a specific documentation file
```json
{
  "name": "read_smithy_doc",
  "description": "Read the full content of a Smithy documentation file",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "Relative path to the documentation file"
      }
    },
    "required": ["file_path"]
  }
}
```

**list_smithy_topics** — Browse all available documentation files

When Claude needs to help with Smithy, it can search for relevant concepts, read specific guides, or browse available topics. The Knowledge Base handles the semantic matching — searching for "how do I define a service" returns relevant results even if those exact words don't appear in the docs.

Here's what a response looks like:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 3 relevant results:\n\n1. Service Definition (quickstart.md)\nServices in Smithy are defined using the service shape...\n\n2. Service Traits (traits.md)\nYou can apply traits to services to add metadata...\n\n3. Service Lifecycle (guides/service-lifecycle.md)\nServices have a defined lifecycle..."
    }
  ]
}
```

## Why This Pattern Works

Traditional approaches to documentation in LLM workflows fall into a few camps:

1. **Fine-tuning** — Expensive, slow to update, overkill for documentation
2. **Prompt stuffing** — Hit context limits fast, expensive at scale
3. **Manual copy-paste** — What we've all been doing, and it's terrible

MCP + Knowledge Bases gives you:
- **Semantic search** — Find relevant docs even with fuzzy queries
- **Always up-to-date** — Re-run ingestion when docs change
- **Cost effective** — ~$5/month vs hundreds for OpenSearch Serverless
- **Scoped context** — Only relevant chunks enter the context window
- **Reusable** — Any MCP client can use it (Claude Desktop, IDEs, custom tools)

The Knowledge Base does the heavy lifting of chunking, embedding, and retrieval. The Lambda function is just a thin MCP wrapper. The whole thing deploys in minutes with CDK.

## The Bottom Line

LLMs are incredible at understanding and generating code, but they're only as good as the context you give them. For specialized tools like Smithy, cramming docs into prompts doesn't scale. MCP servers backed by Bedrock Knowledge Bases give LLMs the ability to search and retrieve exactly what they need, when they need it.

This pattern isn't Smithy-specific. Any large documentation set, internal wiki, or knowledge base can benefit from this approach. The infrastructure is simple, the costs are low, and the developer experience is significantly better than manually managing context.

If you're building with specialized tools and frameworks, consider building an MCP server. Your future self (and your LLM) will thank you.

---

**Want to try it?** The full setup instructions are at [smithymcp.com](https://smithymcp.com). The architecture is reusable for any documentation set — just swap out the ingestion source.
