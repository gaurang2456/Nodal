# Nodal

### AI-Powered Repository Intelligence & Developer Workflow

Nodal is an AI-powered developer tool that helps developers **understand, explore, modify, validate, and ship codebases**.

Instead of treating a repository as a collection of files, Nodal builds an understanding of the codebase using:

- Semantic search
- Vector embeddings
- RAG
- AST-based code analysis
- Code relationships
- Architecture visualization
- AI-powered feature planning
- AI-generated code changes
- Diff-based review
- Automated validation
- GitHub integration

The goal is simple:

> **Understand the codebase before changing it, review changes before applying them, and never silently destroy existing work.**

---

## 🚀 What Nodal Does

Nodal provides an end-to-end workflow for working with unfamiliar or complex repositories.

```text
Repository
    ↓
Repository Analysis
    ↓
Semantic Search + Code Graph
    ↓
Architecture Understanding
    ↓
AI Feature Planning
    ↓
AI Code Generation
    ↓
Diff Review
    ↓
Validation
    ↓
Human Approval
    ↓
GitHub Feature Branch
    ↓
Commit & Push
    ↓
Pull Request
```

This allows developers to move from **understanding a repository** to **safely implementing a feature** without losing control of the changes.

---

# ✨ Features

## 📦 Repository Ingestion

Nodal can ingest repositories from:

- Uploaded repository files
- GitHub repository URLs
- Connected GitHub accounts

During ingestion, the repository is analyzed and its contents are stored for further processing.

---

## 🔎 Semantic Code Search

Nodal converts repository content into semantic chunks and generates vector embeddings.

This enables meaning-based search instead of relying only on exact keyword matching.

For example, instead of searching for:

```text
authentication
```

Nodal can retrieve code related to:

- Login
- Sessions
- OAuth
- JWT handling
- User authentication middleware

even when the exact search term does not appear in the source code.

---

## 🧠 Repository-Aware AI Chat

Nodal provides an AI chat interface that uses repository context to answer questions about the codebase.

The system uses Retrieval-Augmented Generation (RAG) to retrieve relevant code before generating a response.

Responses can include citations pointing back to relevant repository files.

Example questions:

```text
How does authentication work in this project?

Where is the database connection initialized?

Which files are responsible for user registration?

How does the application handle API errors?

What would I need to change to add email verification?
```

---

# 🕸️ AST-Based Code Graph

Nodal uses AST analysis to understand the structure of the source code.

The system extracts symbols such as:

- Classes
- Functions
- Interfaces
- Methods
- Variables
- Imports

It also builds relationships between symbols.

Supported relationship types include:

```text
IMPORTS
EXTENDS
IMPLEMENTS
USES
INJECTS
CALLS
```

This creates a graph representation of how different parts of the repository interact.

---

# 🏗️ Architecture Visualization

The extracted code relationships are used to generate an interactive architecture view.

Instead of manually searching through hundreds of files, developers can visually explore relationships between different parts of the codebase.

The architecture graph can help answer questions such as:

```text
Which components depend on this class?

Where is this service used?

Which files import this module?

What extends this base class?

What parts of the system are connected to this component?
```

---

# 📁 File Explorer

Nodal includes a repository file explorer for navigating analyzed repositories.

Developers can:

- Browse repository files
- Navigate directories
- Open source files
- Inspect file contents
- Move between architecture nodes and their corresponding files

This connects the abstract architecture graph back to the actual source code.

---

# 🔐 Authentication

Nodal supports authentication through Supabase Auth.

Supported authentication methods include:

- Email / Password
- Google OAuth
- GitHub OAuth

GitHub authentication also enables authenticated GitHub operations after the user connects their account.

Sensitive GitHub provider tokens remain server-side and are not exposed to the frontend.

---

# 📝 AI Feature Planning

Nodal can turn a natural-language feature request into an implementation plan.

For example:

```text
Add email verification to the registration flow.
```

The AI analyzes the repository and produces a structured feature plan identifying the files and areas that need to change.

The planning stage is designed to happen **before code generation**.

---

# 🤖 AI Code Generation

After approving a feature plan, Nodal can generate the required code changes.

Instead of immediately modifying the repository, the generated changes are represented as a versioned changeset.

This provides a controlled workflow:

```text
Feature Request
      ↓
AI Analysis
      ↓
Feature Plan
      ↓
Human Approval
      ↓
Code Generation
      ↓
Versioned Changeset
```

---

# 🔀 Versioned Changesets

Generated changes are stored as immutable/versioned changesets.

This makes it possible to:

- Review generated changes
- Compare different versions
- Approve changes
- Reject changes
- Regenerate changes
- Track the state of proposed modifications

The original repository is not immediately overwritten.

---

# 📊 Diff Viewer

Nodal provides a Git-style diff viewer for generated changes.

Developers can inspect:

- Added files
- Modified files
- Deleted files
- Added lines
- Removed lines
- Original content
- Proposed content

The diff can be viewed in a unified or side-by-side format.

The workflow is intentionally:

```text
Generate
   ↓
Review Diff
   ↓
Validate
   ↓
Approve
```

rather than blindly applying AI-generated code.

---

# 🧪 Automated Code Validation

Before changes are shipped, Nodal can validate the proposed changes inside a temporary workspace.

Validation can detect and use repository tooling where applicable.

For example:

```text
TypeScript
Build
Tests
```

Validation is repository-aware.

If a particular validation method is not applicable, it is skipped instead of being incorrectly reported as a failure.

For example, a repository without a `tsconfig.json` should not be treated as a TypeScript validation failure.

Validation states distinguish between:

```text
PASSED
FAILED
SKIPPED
ERROR
```

This prevents missing tooling from being confused with broken code.

---

# 🐙 GitHub Integration

Nodal integrates with GitHub to provide a controlled path from generated code to an actual repository change.

The GitHub workflow is designed around feature branches rather than directly modifying the default branch.

```text
Approved Changeset
       ↓
GitHub Feature Branch
       ↓
Commit
       ↓
Push
       ↓
Pull Request
```

---

# 🌿 Safe Feature Branches

Nodal never directly modifies the repository's default branch during the feature workflow.

Feature branches are created using a deterministic naming pattern:

```text
nodal/feature-plan-{planId}-v{version}
```

The system dynamically detects the repository's default branch before creating the feature branch.

---

# 🛡️ Repository Drift Protection

One of the most important safety mechanisms in Nodal is repository drift detection.

Suppose Nodal generated a change based on:

```text
Version A
```

but the repository has since changed to:

```text
Version B
```

Applying the old changes blindly could overwrite newer developer work.

Nodal therefore checks whether the repository still matches the state against which the changeset was generated.

If the repository has drifted:

```text
STOP
```

rather than silently overwriting newer code.

This is particularly important for AI-generated code changes.

---

# 💾 Git Commit & Push

Approved changes can be committed to the generated GitHub feature branch.

The workflow is designed to:

- Avoid modifying the default branch
- Create one logical commit per changeset
- Prevent duplicate commits
- Protect against branch SHA conflicts
- Re-check repository state
- Persist GitHub commit metadata

---

# 🔗 Pull Request Creation

After changes are committed and pushed, Nodal can create a GitHub Pull Request.

The Pull Request workflow includes:

- Correct feature branch
- Correct base branch
- Deterministic title
- Generated description
- Validation summary
- Changeset information

Nodal does **not automatically merge the Pull Request**.

The final merge decision remains with the developer.

---

# 🧩 System Architecture

```text
┌───────────────────────────────────────────────┐
│                  Next.js App                  │
│                                               │
│  Repository UI                                │
│  File Explorer                                │
│  Architecture Graph                           │
│  AI Chat                                      │
│  Feature Planning                             │
│  Diff Viewer                                  │
│  Validation                                   │
│  GitHub Workflow                              │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│              Next.js API Routes               │
│                                               │
│  Repository APIs                              │
│  RAG APIs                                     │
│  Architecture APIs                            │
│  Changeset APIs                               │
│  Validation APIs                              │
│  GitHub APIs                                  │
└───────────────────────┬───────────────────────┘
                        │
            ┌───────────┴───────────┐
            ▼                       ▼
┌──────────────────────┐   ┌──────────────────────┐
│      Supabase        │   │       GitHub         │
│                      │   │                      │
│ PostgreSQL           │   │ Repository           │
│ pgvector             │   │ Branches             │
│ Authentication       │   │ Commits              │
│ Repository Data      │   │ Pull Requests        │
│ Code Graph           │   │ Git Data API         │
└──────────────────────┘   └──────────────────────┘
```

---

# 🛠️ Tech Stack

## Frontend

- Next.js
- React
- TypeScript
- Tailwind CSS

## Backend

- Next.js API Routes
- TypeScript
- Node.js

## Database

- Supabase
- PostgreSQL
- pgvector

## Authentication

- Supabase Auth
- Google OAuth
- GitHub OAuth

## AI / RAG

- Large Language Models
- Embeddings
- Vector similarity search
- Retrieval-Augmented Generation

## Code Analysis

- TypeScript AST
- `ts-morph`
- Symbol extraction
- Relationship analysis

## GitHub

- GitHub REST API
- Git Data API
- Branch creation
- Commits
- Pull Requests

## Testing

- TypeScript type checking
- Automated test suite
- Repository-aware validation

---

# 📂 Project Structure

```text
Nodal/
│
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── repositories/
│   │   │   ├── changesets/
│   │   │   ├── github/
│   │   │   ├── architecture/
│   │   │   └── ...
│   │   │
│   │   ├── login/
│   │   ├── signup/
│   │   └── ...
│   │
│   ├── components/
│   │   ├── repository/
│   │   ├── architecture/
│   │   ├── chat/
│   │   ├── changesets/
│   │   ├── github/
│   │   └── ...
│   │
│   ├── lib/
│   │   ├── ai/
│   │   ├── github/
│   │   ├── rag/
│   │   ├── repository/
│   │   ├── validation/
│   │   └── ...
│   │
│   └── ...
│
├── supabase/
│   └── migrations/
│
├── tests/
│
├── public/
│
├── package.json
├── tsconfig.json
└── README.md
```

---

# 🗄️ Core Data Model

Nodal stores information about repositories, files, semantic chunks, code symbols, relationships, plans, changesets, and GitHub operations.

The main concepts include:

```text
Users
  │
  └── Repositories
        │
        ├── Repository Files
        │      └── Semantic Chunks
        │
        ├── Code Symbols
        │      └── Code Relationships
        │
        ├── Feature Plans
        │      └── Changesets
        │             ├── Validation
        │             └── GitHub Branch
        │                    ├── Commit
        │                    └── Pull Request
        │
        └── Chat / RAG Context
```

---

# 🔄 Complete Developer Workflow

## 1. Add a Repository

A developer uploads a repository or provides a GitHub repository.

```text
Repository
    ↓
Ingestion
    ↓
File Storage
```

---

## 2. Analyze the Repository

Nodal processes the repository and creates:

```text
Source Files
     ↓
Semantic Chunks
     ↓
Embeddings

Source Files
     ↓
AST Analysis
     ↓
Symbols
     ↓
Relationships
```

---

## 3. Understand the Architecture

The generated symbols and relationships are used to build an architecture graph.

Developers can navigate from graph nodes back to their source files.

---

## 4. Ask Questions

The developer can use repository-aware AI chat.

```text
Question
   ↓
Semantic Retrieval
   ↓
Relevant Repository Context
   ↓
AI Response
   ↓
File Citations
```

---

## 5. Request a Feature

The developer describes a desired change.

```text
"Add password reset functionality."
```

Nodal analyzes the repository and generates a feature plan.

---

## 6. Review the Plan

The developer reviews the proposed implementation before code generation.

---

## 7. Generate Code

After approval, Nodal generates a versioned changeset.

```text
Feature Plan
     ↓
AI Code Generation
     ↓
Changeset
```

---

## 8. Review the Diff

The developer inspects the generated changes using the diff viewer.

---

## 9. Validate

Nodal creates a temporary workspace and validates the proposed changes using applicable repository tooling.

```text
Changeset
    ↓
Temporary Workspace
    ↓
Apply Changes
    ↓
Validation
```

---

## 10. Approve

Only after the developer reviews and approves the changes can they proceed to the GitHub workflow.

---

## 11. Create Feature Branch

Nodal creates a dedicated feature branch.

```text
main
 │
 └── nodal/feature-plan-...
```

The default branch is not directly modified.

---

## 12. Commit & Push

The approved changes are committed and pushed to the feature branch.

---

## 13. Create Pull Request

Nodal creates a Pull Request targeting the repository's default branch.

The developer retains control over the final merge.

---

# 🔒 Security Principles

Nodal follows several principles when handling repositories and GitHub operations.

### No Direct Default-Branch Modification

Generated changes are pushed to feature branches rather than directly modifying the default branch.

### Human Approval

AI-generated code is reviewed before being shipped.

### Repository Drift Detection

Changes are not blindly applied when the repository has changed since the changeset was generated.

### Server-Side GitHub Credentials

GitHub provider tokens are kept server-side and are not exposed to the client.

### Temporary Validation Environments

Proposed changes are validated in temporary workspaces rather than directly modifying the original repository.

### Immutable Changesets

Generated changes are represented as versioned changesets, allowing developers to review different generated versions.

---

# ⚙️ Getting Started

## Prerequisites

Make sure you have:

- Node.js
- npm
- A Supabase project
- Required AI API credentials
- GitHub OAuth configuration if GitHub features are enabled

---

## 1. Clone the Repository

```bash
git clone <your-repository-url>
cd Nodal
```

---

## 2. Install Dependencies

```bash
npm install
```

---

## 3. Configure Environment Variables

Create a `.env.local` file:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# AI provider configuration
AI_API_KEY=your_ai_api_key

# GitHub OAuth / API configuration
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
```

Use the exact environment variable names required by your current implementation.

Do not commit `.env.local` or any secret credentials to Git.

---

# 🗃️ Database Setup

Nodal uses Supabase PostgreSQL with `pgvector`.

Apply the database migrations located in:

```text
supabase/migrations/
```

The database contains structures for concepts such as:

```text
Repositories
Repository Files
Semantic Chunks
Code Symbols
Code Relationships
Feature Plans
Changesets
Changeset Branches
Pull Requests
```

---

# ▶️ Running Locally

Start the development server:

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

---

# 🧪 Testing

Run the TypeScript type check:

```bash
npx tsc --noEmit
```

Run the complete test suite:

```bash
npm test
```

Run a specific test:

```bash
node --import tsx --test <test-file>
```

---

# 📊 Current Project Status

| Feature | Status |
|---|---|
| Repository ingestion | ✅ Complete |
| GitHub repository ingestion | ✅ Complete |
| Semantic chunking | ✅ Complete |
| Embeddings / vector search | ✅ Complete |
| RAG chat | ✅ Complete |
| Repository summaries | ✅ Complete |
| AST symbol extraction | ✅ Complete |
| Code relationships | ✅ Complete |
| Architecture visualization | ✅ Complete |
| File Explorer | ✅ Complete |
| Authentication | ✅ Complete |
| Google OAuth | ✅ Complete |
| GitHub OAuth | ✅ Complete |
| AI feature planning | ✅ Complete |
| AI code generation | ✅ Complete |
| Versioned changesets | ✅ Complete |
| Diff viewer | ✅ Complete |
| Code validation | ✅ Complete |
| GitHub branch creation | ✅ Complete |
| Repository drift protection | ✅ Complete |
| GitHub commit / push | ✅ Complete |
| Pull Request creation | ✅ Complete |
| Navigation / data-fetch optimization | 🚧 In Progress |
| AI code review | 🎯 Planned |

---

# 🎯 Design Philosophy

Nodal is built around three principles.

## 1. Understand Before Modifying

The system should understand the repository before proposing changes.

```text
Repository
    ↓
AST + Semantic Analysis
    ↓
Code Graph
    ↓
Repository Context
    ↓
AI Planning
```

The AI should not treat a repository as a pile of unrelated files.

---

## 2. Review Before Applying

AI-generated code should not immediately modify the user's repository.

```text
Generate
    ↓
Diff
    ↓
Validate
    ↓
Human Approval
    ↓
Apply
```

The developer remains in control of the final change.

---

## 3. Never Destroy Existing Work

Before applying changes, Nodal verifies that the repository still matches the state against which the changeset was generated.

If it does not:

```text
STOP
```

rather than silently overwriting newer code.

---

# 🚧 Future Improvements

Potential future improvements include:

- AI-powered code review
- More advanced repository dependency analysis
- Improved architecture detection
- Better language support
- More validation strategies
- Improved navigation performance
- Smarter client-side data caching
- Background repository analysis
- More GitHub workflow automation
- Improved large-repository support
- Advanced code impact analysis

---

# 🤝 Contributing

Contributions are welcome.

A typical development workflow is:

```text
Fork
  ↓
Create Feature Branch
  ↓
Make Changes
  ↓
Run Type Check
  ↓
Run Tests
  ↓
Submit Pull Request
```

Please keep changes focused and maintain the existing project architecture.

---

# 👨‍💻 Author

**Gaurang Kishore**

Built as an exploration of AI-assisted software engineering, repository intelligence, code analysis, RAG, and safe automated development workflows.

---

# ⭐ Project Summary

Nodal is designed to bridge the gap between **AI-generated code** and **responsible software engineering**.

It combines:

```text
Semantic Understanding
        +
AST Analysis
        +
Code Graph
        +
RAG
        +
AI Planning
        +
AI Code Generation
        +
Human Review
        +
Validation
        +
GitHub Automation
```

into a single developer workflow.

The core idea is:

> **Understand the code. Plan the change. Generate the code. Review the diff. Validate it. Then ship it safely.**
