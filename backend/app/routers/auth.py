import secrets
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.auth import verify_password, get_password_hash, create_access_token, get_current_active_user
from app.core.config import settings
from app.models.email_token import EmailToken, EmailTokenType
from app.models.user import User
from app.schemas.user import (
    EmailVerificationRequest,
    PasswordResetConfirm,
    PasswordResetRequest,
    ResendVerificationRequest,
    Token,
    UserCreate,
    UserLogin,
    UserResponse,
    UserUpdate,
)
from app.services.email import (
    build_password_reset_email,
    build_verification_email,
    send_email,
    is_email_configured,
)

logger = logging.getLogger(__name__)

router = APIRouter()

@router.post("/register", response_model=UserResponse)
def register(user: UserCreate, db: Session = Depends(get_db)):
    """Register a new user."""
    # Check if user already exists
    existing_user = db.query(User).filter(User.email == user.email).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered"
        )
    
    # Create new user
    hashed_password = get_password_hash(user.password)
    db_user = User(
        email=user.email,
        password_hash=hashed_password,
        first_name=user.first_name,
        last_name=user.last_name,
        default_currency=user.default_currency
    )
    
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    
    # Send verification email (non-blocking - log warning if it fails)
    email_sent = _send_verification_email(db, db_user)
    if not email_sent:
        logger.warning(
            f"Failed to send verification email to {user.email}. "
            "User registration succeeded but email verification may not be available. "
            "Please check email configuration (RESEND_API_KEY and RESEND_FROM_EMAIL)."
        )

    return db_user

@router.post("/login", response_model=Token)
def login(user_credentials: UserLogin, db: Session = Depends(get_db)):
    """Login user and return access token."""
    # Verify user credentials
    user = db.query(User).filter(User.email == user_credentials.email).first()
    if not user or not verify_password(user_credentials.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Inactive user"
        )

    if not user.is_verified:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email not verified"
        )
    
    # Update last login
    user.last_login = datetime.utcnow()
    db.commit()
    
    # Create access token
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.email}, expires_delta=access_token_expires
    )
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
    }

@router.get("/me", response_model=UserResponse)
def get_current_user_info(current_user: User = Depends(get_current_active_user)):
    """Get current user information."""
    return current_user

@router.put("/me", response_model=UserResponse)
def update_current_user(
    user_update: UserUpdate,
    current_user: User = Depends(get_current_active_user),
    db: Session = Depends(get_db)
):
    """Update current user information."""
    update_data = user_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(current_user, field, value)
    
    current_user.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(current_user)
    
    return current_user

@router.post("/logout")
def logout(current_user: User = Depends(get_current_active_user)):
    """Logout user (client should discard token)."""
    return {"message": "Successfully logged out"}


@router.patch("/complete-onboarding", response_model=UserResponse)
def complete_onboarding(current_user: User = Depends(get_current_active_user), db: Session = Depends(get_db)):
    """Mark onboarding as completed for the current user."""
    current_user.onboarding_completed = True
    current_user.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(current_user)
    return current_user


@router.post("/verify-email")
def verify_email(payload: EmailVerificationRequest, db: Session = Depends(get_db)):
    token = (
        db.query(EmailToken)
        .filter(
            EmailToken.token == payload.token,
            EmailToken.token_type == EmailTokenType.VERIFY_EMAIL,
        )
        .first()
    )
    if not token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired token")

    if token.expires_at < datetime.utcnow():
        db.delete(token)
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Token has expired")

    user = token.user
    user.is_verified = True
    user.updated_at = datetime.utcnow()
    db.query(EmailToken).filter(
        EmailToken.user_id == user.id,
        EmailToken.token_type == EmailTokenType.VERIFY_EMAIL,
    ).delete()
    db.commit()

    return {"message": "Email verified successfully"}


@router.post("/resend-verification")
def resend_verification(request: ResendVerificationRequest, db: Session = Depends(get_db)):
    """Resend verification email to user."""
    user = db.query(User).filter(User.email == request.email).first()
    if not user:
        # Do not leak registered emails
        return {"message": "If that account exists, a verification email has been sent."}

    if user.is_verified:
        return {"message": "Email is already verified."}

    email_sent = _send_verification_email(db, user)
    if not email_sent:
        logger.warning(f"Failed to resend verification email to {request.email}")
    
    return {"message": "If that account exists, a verification email has been sent."}


@router.post("/forgot-password")
def forgot_password(request: PasswordResetRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == request.email).first()
    if not user or not user.is_active:
        # Respond generically to avoid email enumeration
        return {"message": "If that account exists, a reset link has been sent."}

    token = _create_email_token(
        db,
        user=user,
        token_type=EmailTokenType.RESET_PASSWORD,
        expire_hours=settings.PASSWORD_RESET_EXPIRE_HOURS,
    )

    reset_url = f"{settings.FRONTEND_BASE_URL.rstrip('/')}/reset-password?token={token}"
    email_payload = build_password_reset_email(recipient=user.email, reset_url=reset_url)
    send_email(**email_payload)
    return {"message": "If that account exists, a reset link has been sent."}


@router.post("/reset-password")
def reset_password(payload: PasswordResetConfirm, db: Session = Depends(get_db)):
    token = (
        db.query(EmailToken)
        .filter(
            EmailToken.token == payload.token,
            EmailToken.token_type == EmailTokenType.RESET_PASSWORD,
        )
        .first()
    )
    if not token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired token")

    if token.expires_at < datetime.utcnow():
        db.delete(token)
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Token has expired")

    user = token.user
    user.password_hash = get_password_hash(payload.new_password)
    user.updated_at = datetime.utcnow()
    db.query(EmailToken).filter(
        EmailToken.user_id == user.id,
        EmailToken.token_type == EmailTokenType.RESET_PASSWORD,
    ).delete()
    db.commit()

    return {"message": "Password updated successfully."}


@router.get("/email-config")
def check_email_config():
    """Diagnostic endpoint to check email service configuration."""
    logger.info("Email configuration check requested")
    is_configured = is_email_configured()
    config_status = {
        "configured": is_configured,
        "has_api_key": bool(settings.RESEND_API_KEY),
        "has_from_email": bool(settings.RESEND_FROM_EMAIL),
        "from_email": settings.RESEND_FROM_EMAIL if settings.RESEND_FROM_EMAIL else None,
        "frontend_base_url": settings.FRONTEND_BASE_URL,
        "environment": settings.ENVIRONMENT,
    }
    
    if not is_configured:
        config_status["message"] = "Email service is not configured. Please set RESEND_API_KEY and RESEND_FROM_EMAIL environment variables."
        if not settings.RESEND_API_KEY:
            config_status["issues"] = config_status.get("issues", []) + ["RESEND_API_KEY is missing"]
            logger.warning("RESEND_API_KEY is missing")
        if not settings.RESEND_FROM_EMAIL:
            config_status["issues"] = config_status.get("issues", []) + ["RESEND_FROM_EMAIL is missing"]
            logger.warning("RESEND_FROM_EMAIL is missing")
    else:
        config_status["message"] = "Email service is configured."
        logger.info(f"Email service is configured - From: {settings.RESEND_FROM_EMAIL}")
        # Check if API key looks valid (starts with 're_')
        if settings.RESEND_API_KEY and not settings.RESEND_API_KEY.startswith('re_'):
            config_status["warning"] = "RESEND_API_KEY does not start with 're_' - it may be invalid."
            logger.warning("RESEND_API_KEY does not start with 're_' - it may be invalid")
    
    logger.info(f"Email config check result: {config_status}")
    return config_status


def _create_email_token(
    db: Session,
    *,
    user: User,
    token_type: EmailTokenType,
    expire_hours: int,
) -> str:
    # Remove existing tokens of the same type
    db.query(EmailToken).filter(EmailToken.user_id == user.id, EmailToken.token_type == token_type).delete()

    token_value = secrets.token_urlsafe(48)
    expires_at = datetime.utcnow() + timedelta(hours=expire_hours)
    db_token = EmailToken(
        user_id=user.id,
        token=token_value,
        token_type=token_type,
        expires_at=expires_at,
    )
    db.add(db_token)
    db.commit()
    db.refresh(db_token)
    return token_value


def _send_verification_email(db: Session, user: User) -> bool:
    """Send verification email to user. Returns True if email was sent successfully."""
    try:
        token = _create_email_token(
            db,
            user=user,
            token_type=EmailTokenType.VERIFY_EMAIL,
            expire_hours=settings.EMAIL_VERIFICATION_EXPIRE_HOURS,
        )
        verification_url = f"{settings.FRONTEND_BASE_URL.rstrip('/')}/verify-email?token={token}"
        email_payload = build_verification_email(recipient=user.email, verification_url=verification_url)
        result = send_email(**email_payload)
        return result
    except Exception as e:
        logger.exception(f"Error sending verification email to {user.email}: {e}")
        return False
