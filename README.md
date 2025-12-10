# AI Chat Application

A simple AI chat application using **Hugging Face's free API**.

## Setup Instructions

### 1. Get a Free API Key
1. Go to [Hugging Face](https://huggingface.co/)
2. Create a free account
3. Go to [Settings → Access Tokens](https://huggingface.co/settings/tokens)
4. Click "New token" and create a token
5. Copy your token

### 2. Configure the API Key
1. Open the `.env` file
2. Replace `your_api_key_here` with your actual token:
   ```
   HUGGING_FACE_API_KEY=hf_your_actual_token_here
   ```

### 3. Install Dependencies
```powershell
npm install
```

### 4. Start the Server
```powershell
npm start
```

### 5. Open the Chat
Open `index.html` in your browser or go to `http://localhost:3000`

## Features
- Real AI responses using Hugging Face's DialoGPT model
- Clean, modern chat interface
- Completely free (no payment required)
- Easy to set up and use

## Note
The first message might take a few seconds as the AI model loads. Subsequent messages will be faster!
