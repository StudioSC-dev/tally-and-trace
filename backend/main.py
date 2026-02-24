import uvicorn
import logging
import sys

# Configure logging before uvicorn starts
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    force=True,
    handlers=[logging.StreamHandler(sys.stdout)]
)

# Set log levels
logging.getLogger("app").setLevel(logging.INFO)
logging.getLogger("app.services.email").setLevel(logging.INFO)
logging.getLogger("app.routers.auth").setLevel(logging.INFO)
logging.getLogger("app.routers").setLevel(logging.INFO)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"  # Ensure uvicorn uses INFO level
    )

