# Use Node.js v25.2.1
FROM node:25.2.1-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY . .

# Expose port (use PORT env variable or default 3000)
EXPOSE 8080

# Start the application
CMD ["npm", "start"]
