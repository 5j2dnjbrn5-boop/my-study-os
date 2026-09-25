import { GoogleGenAI } from '@google/genai';

// Supported Gemini models as requested: 3.1 Flash Lite, 3.5 Flash, 3.5 Flash Lite, 3.6 Flash, 3.7 Flash, 3.8 Flash
export const SUPPORTED_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getLocalNoteSummary(noteContent, noteTitle, courseName) {
  const lines = noteContent
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Extract key sentences or bullet points
  const candidatePoints = lines.filter((l) => l.length > 5 && !l.startsWith('#'));
  const keyPoints = candidatePoints.slice(0, 4).map((p) => p.replace(/^[-*•0-9.)\s]+/, '').trim());

  if (keyPoints.length === 0) {
    keyPoints.push(`สาระสำคัญของ ${noteTitle || 'หัวข้อนี้'}`);
  }

  const shortSummary = lines.slice(0, 3).join(' ').slice(0, 200) || `สรุปประเด็นหลักของเนื้อหา ${noteTitle}`;

  return {
    summary: shortSummary,
    keyPoints: keyPoints,
    examTips: `📌 จุดเน้นสำหรับวิชา ${courseName || 'นี้'}: ทบทวนนิยาม คีย์เวิร์ดสำคัญ และตัวอย่างการนำไปประยุกต์ใช้ในการแก้โจทย์`,
    mnemonic: `💡 เทคนิคจำ: เชื่อมโยง ${noteTitle || 'หัวข้อหลัก'} กับโจทย์ฝึกหัดหรือ Flashcard 3 ประเด็นสำคัญ`,
    isLocalFallback: true,
    modelUsed: 'Local Smart Summarizer',
  };
}

async function generateWithFallback(ai, contents, genConfig, preferredModel = null) {
  let lastError = null;

  let modelsToTry = [...SUPPORTED_MODELS];
  if (preferredModel && SUPPORTED_MODELS.includes(preferredModel)) {
    modelsToTry = [preferredModel, ...SUPPORTED_MODELS.filter((m) => m !== preferredModel)];
  }

  for (const model of modelsToTry) {
    try {
      console.log(`Calling Gemini for note summary: ${model}`);
      const responsePromise = ai.models.generateContent({
        model,
        contents,
        config: genConfig,
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after 10s for ${model}`)), 10000)
      );

      const response = await Promise.race([responsePromise, timeoutPromise]);
      if (response && response.text) {
        console.log(`Gemini note summary success using: ${model}`);
        return { response, modelUsed: model };
      }
    } catch (err) {
      lastError = err;
      const msg = err?.message || '';
      console.warn(`Model ${model} note summary failed:`, msg.slice(0, 100));

      await sleep(300);
    }
  }

  throw lastError || new Error('All AI models unavailable');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { courseName, noteTitle, noteContent, preferredModel } = req.body || {};

  if (!noteContent || !noteContent.trim()) {
    return res.status(400).json({ error: 'Note content is required' });
  }

  try {
    if (!process.env.GEMINI_API_KEY) {
      console.warn('GEMINI_API_KEY missing, using local note summary');
      return res.status(200).json(getLocalNoteSummary(noteContent, noteTitle, courseName));
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const systemInstructions = `คุณคือผู้ช่วยติวเตอร์วิชาการระดับมหาวิทยาลัย (University Academic Tutor & Summarizer)
หน้าที่ของคุณคือสรุปเนื้อหาโน้ตการเรียนให้เข้าใจง่าย กระชับ ตรงประเด็น และเน้นจุดที่นำไปใช้สอบได้จริง`;

    const prompt = `${systemInstructions}
วิชา: ${courseName || 'ทั่วไป'}
หัวข้อโน้ต: ${noteTitle || 'โน้ตสรุป'}
เนื้อหาโน้ต:
"""
${noteContent}
"""

กรุณาวิเคราะห์และสร้างข้อสรุปในรูปแบบ JSON ตามโครงสร้างนี้เท่านั้น:
{
  "summary": "สรุปใจความสำคัญแบบกระชับ 2-4 บรรทัด",
  "keyPoints": [
    "ประเด็นสำคัญที่ 1",
    "ประเด็นสำคัญที่ 2",
    "ประเด็นสำคัญที่ 3"
  ],
  "examTips": "ข้อควรระวังหรือจุดที่อาจารย์มักนำมาออกสอบ",
  "mnemonic": "เทคนิคจำหรือสูตรช่วยจำสั้นๆ (ถ้ามี)"
}`;

    let parsedData = null;
    try {
      const { response, modelUsed } = await generateWithFallback(
        ai,
        prompt,
        {
          responseMimeType: 'application/json',
        },
        preferredModel
      );

      const resultText = (response.text || '').replace(/```json/g, '').replace(/```/g, '').trim();
      parsedData = JSON.parse(resultText);
      parsedData.modelUsed = modelUsed;
    } catch (aiErr) {
      console.warn('AI summarize call failed, serving local smart summary:', aiErr?.message?.slice(0, 100));
      parsedData = getLocalNoteSummary(noteContent, noteTitle, courseName);
    }

    return res.status(200).json(parsedData);
  } catch (error) {
    console.error('Error in summarize-notes handler:', error);
    const fallback = getLocalNoteSummary(noteContent, noteTitle, courseName);
    return res.status(200).json(fallback);
  }
}
