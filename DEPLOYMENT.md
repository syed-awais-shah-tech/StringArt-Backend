# StringArt Backend — Cloud Run Deployment Guide

This guide covers building, containerizing, and deploying the **StringArt Backend** Node.js/Express service with Supabase Database and Storage to **Google Cloud Run**.

---

## 1. Overview
- **Framework**: Express 4 (Node.js 20 ES Modules)
- **Image Processing**: Sharp (using Debian Bookworm Slim with native glibc)
- **Database & Storage**: Supabase PostgreSQL (`orders` table) + Supabase Storage (`stringart-orders` private bucket)
- **Hosting Target**: Google Cloud Run (Fully Managed Serverless Container)

---

## 2. Environment Variables

| Variable | Required in Prod | Description | Default / Example |
| :--- | :--- | :--- | :--- |
| `PORT` | Auto (Cloud Run) | Port listened to by the Express HTTP server | `8080` (injected by Cloud Run) |
| `NODE_ENV` | Recommended | Environment mode | `production` |
| `SUPABASE_URL` | **Yes** | Your Supabase Project API URL | `https://your-ref.supabase.co` |
| `SUPABASE_SECRET_KEY`| **Yes** | Supabase Service Role Secret Key (Server-side ONLY) | `eyJhbGci...` |
| `CLIENT_ORIGIN` | **Yes** | URL of your deployed Cloud Run Frontend | `https://stringart-frontend-xyz.run.app` |
| `JWT_SECRET` | **Yes** | Secret key for signing admin session cookies | Random secure string |

> ⚠️ **CRITICAL SECURITY NOTE**: Never commit `SUPABASE_SECRET_KEY` or `JWT_SECRET` to GitHub! Use Cloud Run Environment Variables or Google Cloud Secret Manager.

---

## 3. Local Commands

### Start Command (Production Mode)
```bash
# Starts Express server on PORT (default 3001 locally, or $PORT if set)
npm start
```

### Dev Command (Watch Mode)
```bash
npm run dev
```

### Test Supabase Integration
```bash
npm run test:supabase
```

---

## 4. Docker Usage

### Build the Docker Image
```bash
docker build -t stringart-backend:latest .
```

### Run Locally with Docker
Simulate Cloud Run by setting `PORT=8080`:
```bash
docker run -p 8080:8080 \
  -e PORT=8080 \
  -e NODE_ENV=production \
  -e SUPABASE_URL="https://your-ref.supabase.co" \
  -e SUPABASE_SECRET_KEY="your-service-role-key" \
  -e CLIENT_ORIGIN="http://localhost:5173" \
  stringart-backend:latest
```
Visit health check: [http://localhost:8080/health](http://localhost:8080/health)

---

## 5. Google Cloud Run Deployment

### Step 1: Initialize Database in Supabase
Before deploying the container:
1. Open your [Supabase Dashboard](https://supabase.com/dashboard).
2. Go to **SQL Editor** &rarr; **New query**.
3. Paste the contents of `schema.sql` and click **Run**.
*(This creates the `orders` table and configures the private `stringart-orders` storage bucket).*

### Step 2: Deploy to Google Cloud Run

#### Using `gcloud` CLI:
```bash
# Set project and region
gcloud config set project YOUR_PROJECT_ID
REGION="us-central1"

# Build and deploy directly from source via Cloud Build & Cloud Run
gcloud run deploy stringart-backend \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars "NODE_ENV=production,SUPABASE_URL=https://your-ref.supabase.co,CLIENT_ORIGIN=https://YOUR-FRONTEND-URL.run.app" \
  --set-secrets "SUPABASE_SECRET_KEY=stringart-supabase-key:latest,JWT_SECRET=stringart-jwt-secret:latest"
```

#### Using Cloud Run Console:
1. Go to **Cloud Run** &rarr; **Create Service**.
2. Connect your GitHub repository `StringArt-Backend` on branch `main`.
3. Select **Dockerfile** as the build type.
4. Under **Variables & Secrets**:
   - `PORT`: `8080`
   - `NODE_ENV`: `production`
   - `SUPABASE_URL`: `https://your-ref.supabase.co`
   - `SUPABASE_SECRET_KEY`: Reference Secret from Secret Manager
   - `CLIENT_ORIGIN`: `https://stringart-frontend-xyz.run.app`
5. Click **Create** & deploy.

### Step 3: Connect Frontend
Copy the assigned backend service URL (e.g., `https://stringart-backend-xyz.run.app`) and configure it as `VITE_API_BASE_URL` in your frontend service.
