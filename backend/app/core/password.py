"""Password validation utilities."""
import re
from typing import List, Tuple


def validate_password_strength(password: str) -> Tuple[bool, List[str]]:
    """
    Validate password strength against security requirements.
    
    Returns:
        Tuple of (is_valid, list_of_errors)
    """
    errors = []
    
    # Minimum length
    if len(password) < 8:
        errors.append("Password must be at least 8 characters long")
    
    # Maximum length
    if len(password) > 100:
        errors.append("Password must be no more than 100 characters long")
    
    # Uppercase letter
    if not re.search(r'[A-Z]', password):
        errors.append("Password must contain at least one uppercase letter")
    
    # Lowercase letter
    if not re.search(r'[a-z]', password):
        errors.append("Password must contain at least one lowercase letter")
    
    # Number
    if not re.search(r'\d', password):
        errors.append("Password must contain at least one number")
    
    # Special character
    if not re.search(r'[!@#$%^&*()._+\-=]', password):
        errors.append("Password must contain at least one special character (!@#$%^&*().-_+=)")
    
    return (len(errors) == 0, errors)
