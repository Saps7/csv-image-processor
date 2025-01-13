# FROM node:latest

# WORKDIR /app

# COPY package.json package-lock.json /app/

# RUN npm install

# COPY . .

FROM node:14
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .    
EXPOSE 8082
CMD [ "index.js"]
