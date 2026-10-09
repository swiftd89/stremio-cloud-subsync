FROM node:20-slim

# Install ffmpeg and python3 for audio processing and VAD alignment
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install ffsubsync globally
RUN pip3 install --no-cache-dir ffsubsync --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 7000
CMD ["node", "server.js"]
