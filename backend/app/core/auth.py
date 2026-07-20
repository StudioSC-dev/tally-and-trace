import hashlib
import secrets
from datetime import timedelta
from typing import Optional, Tuple
from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.time import naive_utc_now, utc_now
from app.models.user import User
from app.models.refresh_token import RefreshToken
from app.schemas.user import TokenData
from app.core.config import settings

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# JWT settings
SECRET_KEY = settings.SECRET_KEY
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = settings.ACCESS_TOKEN_EXPIRE_MINUTES

# Security scheme
security = HTTPBearer()

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash."""
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password: str) -> str:
    """Hash a password."""
    return pwd_context.hash(password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    """Create a JWT access token."""
    to_encode = data.copy()
    if expires_delta:
        expire = utc_now() + expires_delta
    else:
        expire = utc_now() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def verify_token(token: str, credentials_exception):
    """Verify and decode a JWT token."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
        token_data = TokenData(email=email)
        return token_data
    except JWTError:
        raise credentials_exception

def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
) -> User:
    """Get the current authenticated user."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    
    token = credentials.credentials
    token_data = verify_token(token, credentials_exception)
    
    user = db.query(User).filter(User.email == token_data.email).first()
    if user is None:
        raise credentials_exception
    
    return user

def get_current_active_user(current_user: User = Depends(get_current_user)) -> User:
    """Get the current active user."""
    if not current_user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    return current_user


# ---------------------------------------------------------------------------
# Refresh tokens (DB-backed, rotating, revocable). Only the hash is stored.
# ---------------------------------------------------------------------------

def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_refresh_token(db: Session, user: User) -> str:
    """Issue a new refresh token for the user and return the plaintext value."""
    token = secrets.token_urlsafe(48)
    record = RefreshToken(
        user_id=user.id,
        token_hash=_hash_token(token),
        expires_at=naive_utc_now() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
    )
    db.add(record)
    db.commit()
    return token


def _get_valid_refresh(db: Session, token: str) -> Optional[RefreshToken]:
    record = db.query(RefreshToken).filter(RefreshToken.token_hash == _hash_token(token)).first()
    if not record or record.revoked_at is not None or record.expires_at < naive_utc_now():
        return None
    return record


def rotate_refresh_token(db: Session, token: str) -> Tuple[Optional[User], Optional[str]]:
    """Validate a refresh token, revoke it, and issue a fresh one. Returns (user, new_token)."""
    record = _get_valid_refresh(db, token)
    if not record:
        return None, None
    user = db.query(User).filter(User.id == record.user_id).first()
    if not user or not user.is_active:
        return None, None
    record.revoked_at = naive_utc_now()
    db.commit()
    return user, create_refresh_token(db, user)


def revoke_refresh_token(db: Session, token: str) -> None:
    record = db.query(RefreshToken).filter(RefreshToken.token_hash == _hash_token(token)).first()
    if record and record.revoked_at is None:
        record.revoked_at = naive_utc_now()
        db.commit()


def revoke_all_refresh_tokens(db: Session, user: User) -> int:
    """Revoke every outstanding refresh token for a user. Returns the number revoked."""
    revoked = (
        db.query(RefreshToken)
        .filter(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .update({RefreshToken.revoked_at: naive_utc_now()}, synchronize_session=False)
    )
    db.commit()
    return revoked
