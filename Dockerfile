FROM node:20-slim

# Install ffmpeg, opus, and SVOX Pico TTS (offline TTS — no API key required)
# libttspico packages are not in Bookworm — pull them from the Debian Buster non-free archive.
RUN echo "deb http://archive.debian.org/debian buster non-free" >> /etc/apt/sources.list.d/buster-nonfree.list \
  && apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    libopus-dev \
    libttspico0 \
    libttspico-data \
    libttspico-utils \
  && rm -rf /var/lib/apt/lists/* \
  && rm /etc/apt/sources.list.d/buster-nonfree.list

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Bundle app source
COPY . .

# Expose the health check port from src/app.js
EXPOSE 3000

# Start the bot
CMD [ "npm", "start" ]
