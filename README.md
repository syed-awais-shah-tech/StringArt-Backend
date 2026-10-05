# 🧵 StringArt — Backend & Generation Engine

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Express-4.18-000000?logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/Sharp-0.33-990000?logo=sharp&logoColor=white" alt="Sharp" />
  <img src="https://img.shields.io/badge/C%2B%2B-17-00599C?logo=c%2B%2B&logoColor=white" alt="C++" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-blue.svg" alt="License" />
</p>

<p align="center">
  <b>High-performance String Art Generation Engine & Protected Order Management Backend.</b><br>
  Transforms raster images into physical string art nail coordinates and powers the customer checkout and admin dashboard.
</p>

---

## ⚡ Core Architecture

The backend consists of two main pillars:
1. **Mathematical String Art Engine** (`engine/`):
   - **Image Preprocessor** (`imageProcessor.js`): Sharp-based pipeline normalizing images, adjusting luminance, brightness, and contrast.
   - **Nail Coordinate Generator** (`nailGenerator.js`): Trigonometric nail mapping across the circular board perimeter.
   - **Greedy Bresenham Error Minimization** (`scoreCalculator.js`): Line candidate evaluation reducing residual error between the woven canvas and the source photograph.
   - **Sequence Formatter** (`sequenceFormatter.js`): Exports step-by-step pin instruction files (`sequence.txt`) for physical workshop looms.
2. **RESTful E-Commerce & Order Management** (`routes/`):
   - Customer Cash on Delivery order creation and asset persistence in Supabase.
   - Protected Shopify-style administration dashboard API with HttpOnly cookie JWT authentication.

---

## 📡 API Reference

### Public & Customer Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Health check and engine status |
| `POST` | `/api/generate` | Multipart photo upload $\rightarrow$ generates string art lines & sequence |
| `GET` | `/api/settings/generation` | Public generation settings (e.g., eightColorEnabled) |
| `POST` | `/api/orders` | Places customer Cash on Delivery (COD) order |
| `GET` | `/api/orders/:id` | Retrieves order details by order number |

### Protected Admin Endpoints

*All `/api/admin/*` routes require `admin_jwt` HttpOnly cookie authentication.*

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/admin/login` | Authenticates admin against Supabase and issues HttpOnly JWT cookie |
| `GET` | `/api/admin/me` | Validates current session from cookie |
| `POST` | `/api/admin/logout` | Clears admin authentication cookie |
| `GET` | `/api/admin/stats` | Returns dashboard KPIs (Total, New, In Production, Shipped, Revenue) |
| `GET` | `/api/admin/orders` | Lists orders with search query and status filters |
| `GET` | `/api/admin/orders/:id` | Full order details with inline sequence preview |
| `PATCH` | `/api/admin/orders/:id` | Updates `orderStatus` and/or `paymentStatus` |
| `GET` | `/api/admin/orders/:id/sequence` | Streams the physical workshop sequence file (`.txt`) |
| `GET` | `/api/admin/settings` | Retrieves current store settings |
| `PATCH` | `/api/admin/settings` | Updates store settings (e.g., eight_color_enabled) |

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) v18.0.0 or higher
- [npm](https://www.npmjs.com/) v9 or higher

### Installation

```bash
git clone https://github.com/syed-awais-shah-tech/StringArt-Backend.git
cd StringArt-Backend

# Install dependencies
npm install
```

### Running the Server

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

The server will listen at [http://localhost:3001](http://localhost:3001).

---

## ⚙️ Environment Variables

Copy `.env.example` to `.env` to configure:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Port to listen on | `3001` |
| `JWT_SECRET` | Secret key for signing admin session cookies | Secure random string |
| `CLIENT_ORIGIN` | Allowed CORS frontend origin | `http://localhost:5173` |
| `SUPABASE_URL` | Supabase project URL | (required) |
| `SUPABASE_SECRET_KEY` | Supabase service role secret key | (required) |
| `NODE_ENV` | Node environment | `development` |

---

## 🛠️ Optional Native C++ Engine

For high-throughput command-line batch jobs or OpenCL hardware acceleration, the original native C++ sources are included:

- **Source Code**: `src/`, `main.cpp`
- **OpenCL Kernels**: `kernels/`
- **Build Tool**: `CMakeLists.txt`

### Compiling C++ Binary
```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

### Running Native CLI
```bash
./StringArt -ii assets/input.png -oi assets/output.png -n 250 -it 3000
```

---

## 📁 Project Structure

```text
StringArt-Backend/
├── data/                    # JSON database & uploaded orders
│   ├── orders.json          # Persisted orders store
│   └── orders/              # Original photos, previews & sequence files
├── engine/                  # Core string art generation algorithm
│   ├── imageProcessor.js    # Sharp image preprocessing
│   ├── nailGenerator.js     # Perimeter nail trigonometry
│   ├── scoreCalculator.js   # Bresenham greedy residual minimization
│   └── sequenceFormatter.js # Sequence instruction file builder
├── middleware/              # Rate limiters & security middleware
├── routes/                  # Express API routers
│   ├── admin.js             # Protected admin auth & order actions
│   ├── generate.js          # Photo generation handler
│   └── orders.js            # Customer checkout handler
├── src/                     # Optional C++ native source files
├── kernels/                 # Optional OpenCL GPU kernels
├── assets/                  # Sample test assets
├── CMakeLists.txt           # CMake native build file
├── main.cpp                 # C++ CLI entry point
├── index.js                 # Express server entry point
├── package.json
├── .env.example
└── .gitignore
```

---

## 📜 License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
