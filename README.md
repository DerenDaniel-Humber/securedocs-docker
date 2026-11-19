# SecureDocs Docker starter

A small insurance-document workspace with three separate containers:

- `frontend`: Nginx serves the web UI and forwards `/api/*` calls to the backend.
- `backend`: Express API validates uploads, stores document metadata in MongoDB, and saves file bytes in a persistent volume.
- `mongo`: MongoDB 7 stores document metadata on a persistent volume.

The backend and database are private to the Compose network. The frontend is bound to `127.0.0.1` on the host. API requests use HTTP Basic Authentication; the browser prompts for the configured username and password.

## Start

From this directory:

```sh
cp .env.example .env
```

Change `SECUREDOCS_PASSWORD` in `.env`, then start the app:

```sh
docker compose up --build -d
```

Open <http://localhost:8080>. Check container health and logs with:

```sh
docker compose ps
docker compose logs -f backend
```

Stop containers while retaining MongoDB and uploaded-file data:

```sh
docker compose down
```

To erase the stored MongoDB records and uploaded files too:

```sh
docker compose down -v
```

## Container connections

Compose provides DNS names on the private `securedocs_net` network. The backend connects to `mongodb://mongo:27017/securedocs`; the frontend Nginx proxy connects to `http://backend:3000`. Do not use `localhost` between containers. MongoDB has no host port mapping.

## API

- `GET /api/health` — service and Mongo connection state
- `GET /api/documents` — newest-first document metadata
- `POST /api/documents` — multipart upload with `title`, `category`, optional `customerName` and `policyNumber`, and `file`
- `GET /api/documents/:id/file` — download the stored file
- `DELETE /api/documents/:id` — remove metadata and uploaded bytes

Accepted file types: PDF, PNG, JPG/JPEG and DOCX. The default limit is 10 MB. Change it with `MAX_UPLOAD_MB`; Nginx's request limit is set slightly above that value and can be raised in `frontend/nginx.conf` if needed.

This is a lab starter, not a production insurance records system. Before production use, add organization identity integration, role-based permissions, TLS, malware scanning, encryption/key management and retention/audit policies. Keep `.env` private.
