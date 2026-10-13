import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from local service or workspace root
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const API_KEY = process.env.GEMMA_API_KEY || process.env.GOOGLE_API_KEY;

export function getGenerativeAI(): GoogleGenerativeAI {
  const key = process.env.GEMMA_API_KEY || process.env.GOOGLE_API_KEY || API_KEY;
  if (!key) {
    throw new Error('GEMMA_API_KEY not found in environment variables');
  }
  return new GoogleGenerativeAI(key);
}

export function getGemmaModel(modelName?: string) {
  const genAI = getGenerativeAI();
  return genAI.getGenerativeModel({
    model: modelName || process.env.GEMMA_MODEL || 'gemma-2-9b-it',
  });
}

/**
 * Default Gemma model instance proxy.
 * Resolves the GoogleGenerativeAI model configured in environment variables.
 */
export const gemmaModel = {
  generateContent: async (prompt: string | any) => {
    const model = getGemmaModel();
    return model.generateContent(prompt);
  },
};
