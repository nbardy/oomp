# Claude Multi-Chat

A simple web interface for managing multiple Claude CLI conversations simultaneously.

## Features

- Create multiple concurrent Claude conversations
- Switch between gallery view (all conversations) and chat view (single conversation)
- Real-time streaming responses from Claude
- Visual status indicators for running processes
- Delete conversations when done

## Setup

1. Install dependencies:
```bash
npm install
```

2. Make sure you have `claude` CLI installed and authenticated

3. Start the server:
```bash
npm start
```

4. Open http://localhost:3000 in your browser

## Usage

- Click "+ New Conversation" to start a new Claude session
- Click on any conversation card in the gallery to open it
- Switch between "Gallery" and "Chat" views using the top buttons
- Send messages in the chat view
- Green indicator = Claude process is running
- Gray indicator = Process stopped
- Delete conversations using the delete button (appears on hover in sidebar)

## How it works

- Each conversation spawns a separate `claude` process with JSON streaming I/O
- The backend manages multiple Claude processes and routes messages via WebSocket
- The frontend is a single-page app that displays conversations in grid or chat view
- Messages are streamed in real-time from Claude to the UI
