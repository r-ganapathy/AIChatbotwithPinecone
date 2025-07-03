# RAG AI Chatbot

This is a Node.js Express application providing an endpoint for an AI chatbot using OpenRouter (DeepSeek model) and Retrieval-Augmented Generation (RAG) with Pinecone. It supports document ingestion (PDF, Excel, Word) for context-aware responses.

## Features
- `/upload`: Upload PDF, Excel, or Word documents for ingestion and vectorization.
- `/chat`: Chat endpoint using OpenRouter (DeepSeek) and RAG with Pinecone.

## Setup
1. Install dependencies:
   ```sh
   npm install
   ```
2. Set up your `.env` file with OpenRouter and Pinecone credentials.
3. Start the server:
   ```sh
   npm start
   ```

## Endpoints
- `POST /upload` — Upload a document (form-data, field: `file`).
- `POST /chat` — Send `{ "message": "your question" }` to get a response.

## Notes
- Replace the placeholder embedding logic with a real embedding API for production.
- Ensure your Pinecone index is created and configured.
