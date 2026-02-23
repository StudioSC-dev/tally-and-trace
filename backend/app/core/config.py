from pydantic_settings import BaseSettings
from typing import List, Optional

class Settings(BaseSettings):
    PROJECT_NAME: str = "Tally & Trace API"
    VERSION: str = "2.0.0"
    DESCRIPTION: str = "Multi-entity personal and business financial management"
    API_V1_STR: str = "/api/v1"
    
    # CORS - will be parsed from comma-separated string
    BACKEND_CORS_ORIGINS_STR: str = "http://localhost:3000,http://localhost:8000"
    
    # Database - PostgreSQL
    DATABASE_URL: str = "postgresql://user:password@localhost:5432/tally_trace"
    
    # Security
    SECRET_KEY: str = "your-secret-key-here-change-in-production"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    EMAIL_VERIFICATION_EXPIRE_HOURS: int = 48
    PASSWORD_RESET_EXPIRE_HOURS: int = 4
    FRONTEND_BASE_URL: str = "http://localhost:3000"
    RESEND_API_KEY: Optional[str] = None
    RESEND_FROM_EMAIL: Optional[str] = None

    # File Upload
    UPLOAD_DIR: str = "uploads"
    MAX_FILE_SIZE: int = 10 * 1024 * 1024  # 10MB
    ALLOWED_EXTENSIONS_STR: str = "jpg,jpeg,png,pdf,doc,docx"
    
    # Environment
    ENVIRONMENT: str = "development"
    DEBUG: bool = True
    
    @property
    def BACKEND_CORS_ORIGINS(self) -> List[str]:
        return [origin.strip() for origin in self.BACKEND_CORS_ORIGINS_STR.split(",")]
    
    @property
    def ALLOWED_EXTENSIONS(self) -> List[str]:
        return [ext.strip() for ext in self.ALLOWED_EXTENSIONS_STR.split(",")]
    
    class Config:
        env_file = ".env"
        case_sensitive = True

settings = Settings()
