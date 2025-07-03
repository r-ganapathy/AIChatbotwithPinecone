require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const { Pinecone } = require('@pinecone-database/pinecone');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
const upload = multer({ dest: 'uploads/' });

// Pinecone setup
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

const defaultIndexName = `rag-index-${Date.now()}`;
const embeddingDimension = 1024; // Set to match your existing index
let index;

(async () => {
  try {
    const { indexes } = await pinecone.listIndexes();
    let indexName = "rag-index-1751532614156";
    const found = indexes.find(idx => idx.name === indexName);
    if (!found) {
      await pinecone.createIndex({
        name: indexName,
        dimension: embeddingDimension,
        metric: 'cosine',
        spec: {
          serverless: {
            cloud: 'aws',
            region: 'us-east-1',
          },
        },
      });
      // Wait for index to be ready
      let ready = false;
      while (!ready) {
        const desc = await pinecone.describeIndex({ name: indexName });
        if (desc.status?.ready) ready = true;
        else await new Promise(r => setTimeout(r, 2000));
      }
    }
    index = pinecone.index(indexName);
    console.log(`Using Pinecone index: ${indexName}`);
  } catch (err) {
    console.error('Error setting up Pinecone index:', err);
    process.exit(1);
  }
})();

// Helper: Extract text from PDF
async function extractPdfText(filePath) {
  const fs = require('fs');
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);
  return data.text;
}

// Helper: Extract text from Excel
async function extractExcelText(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  let text = '';
  workbook.eachSheet((sheet) => {
    sheet.eachRow((row) => {
      text += row.values.join(' ') + '\n';
    });
  });
  return text;
}

// Helper: Extract text from Word
async function extractWordText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

// Helper: Chunk text
function chunkText(text, chunkSize = 1000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

// Helper: Embed text using OpenRouter (DeepSeek)
async function embedText(text) {
  // Replace with actual embedding API if available
  // Placeholder: returns random vector
  return Array(1024).fill(0).map(() => Math.random());
}

// Upload endpoint for documents
app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  let text = '';
  try {
    if (!index) return res.status(503).json({ error: 'Pinecone index not ready yet.' });
    if (file.mimetype === 'application/pdf') {
      text = await extractPdfText(file.path);
    } else if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel'
    ) {
      text = await extractExcelText(file.path);
    } else if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      file.mimetype === 'application/msword'
    ) {
      text = await extractWordText(file.path);
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      const embedding = await embedText(chunk);
      await index.upsert([{ id: `${file.filename}-${Math.random()}`, values: embedding, metadata: { text: chunk } }]);
    }
    res.json({ message: 'File processed and indexed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat endpoint
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  try {
    if (!index) return res.status(503).json({ error: 'Pinecone index not ready yet.' });
    const queryEmbedding = await embedText(message);
    const results = await index.query({
      vector: queryEmbedding,
      topK: 5,
      includeMetadata: true,
    });
    const context = results.matches.map(m => m.metadata.text).join('\n');
    // Call OpenRouter (DeepSeek) for response
    try {
      const openrouterRes = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-chat-v3-0324:free',
          messages: [
            {
              role: 'system',
              content: `You are a helpful assistant. Below is context relevant to the user's query:\n\n${context.substring(0, 10000)}
 
IMPORTANT:
- Answer the user's question based only on this context. If the answer is not in the context, clearly state that you don't know.
- Format your answer clearly using markdown (e.g., bullet points, numbered steps, bold headings, etc.) when appropriate.
- Keep answers precise, concise, and easy for a human to understand.
- Do not make up information or speculate beyond the given context.`
            },
            { role: 'user', content: `${message}` },
          ],
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      res.json({ response: openrouterRes.data.choices[0].message.content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streaming chat endpoint (replica of /chat, but streams output)
app.post('/chat-stream', async (req, res) => {
  const { message } = req.body;
  try {
    if (!index) return res.status(503).json({ error: 'Pinecone index not ready yet.' });
    const queryEmbedding = await embedText(message);
    const results = await index.query({
      vector: queryEmbedding,
      topK: 5,
      includeMetadata: true,
    });
    const context = results.matches.map(m => m.metadata.text).join('\n');
    // Stream response from OpenRouter (DeepSeek)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try {
      const openrouterRes = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-chat-v3-0324:free',
          messages: [
            {
              role: 'system',
              content: `You are a helpful assistant. Below is context relevant to the user's query:\n\n${context.substring(0, 10000)}
 
IMPORTANT:
- Answer the user's question based only on this context. If the answer is not in the context, clearly state that you don't know.
- Format your answer clearly using markdown (e.g., bullet points, numbered steps, bold headings, etc.) when appropriate.
- Keep answers precise, concise, and easy for a human to understand.
- Do not make up information or speculate beyond the given context.`
            },
            { role: 'user', content: `${message}` },
          ],
          stream: true
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
        }
      );
      openrouterRes.data.on('data', chunk => {
        res.write(`data: ${chunk.toString()}\n\n`);
      });
      openrouterRes.data.on('end', () => {
        res.write('event: end\ndata: [DONE]\n\n');
        res.end();
      });
      openrouterRes.data.on('error', err => {
        res.write(`event: error\ndata: ${err.message}\n\n`);
        res.end();
      });
    } catch (err) {
      res.write(`event: error\ndata: ${err.message}\n\n`);
      res.end();
    }
  } catch (err) {
    res.write(`event: error\ndata: ${err.message}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
