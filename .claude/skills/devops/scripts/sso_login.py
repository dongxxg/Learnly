#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import hashlib
import random
import requests
import json

def encrypt_password(plain_password):
    """Encrypt password: 6 random digits + MD5 hash"""
    # Generate 6 random digits
    random_prefix = ''.join([str(random.randint(0, 9)) for _ in range(6)])

    # MD5 hash of plain password
    md5_hash = hashlib.md5(plain_password.encode()).hexdigest()

    # Combine: random prefix + MD5 hash
    return random_prefix + md5_hash

def sso_login(username, encrypted_password, server_url="http://192.168.118.247:2011"):
    """Login via SSO and get zy_token"""
    login_url = f"{server_url}/webapi/sso/login"

    params = {
        "userId": username,
        "passwd": encrypted_password
    }

    try:
        response = requests.get(login_url, params=params, verify=False, timeout=10)
        text = response.text

        # Check for error redirect
        if "ssoError" in text:
            return {"success": False, "error": "用户名或密码错误"}

        # Extract token from JavaScript
        import re
        match = re.search(r"'zy_token',\s*'bearer\s+([^']+)'", text)
        if match:
            token = match.group(1)
            return {"success": True, "token": token}

        return {"success": False, "error": "无法从响应中提取token"}

    except Exception as e:
        return {"success": False, "error": f"登录请求失败: {str(e)}"}

def get_token():
    """Get token from config, login if needed"""
    from config import config

    # Try to use stored token first
    stored_token = config.get_token()
    if stored_token:
        return {"success": True, "token": stored_token}

    # No stored token, need to login
    username, encrypted_password = config.get_credentials()
    if not username or not encrypted_password:
        return {"success": False, "error": "未配置用户凭证，请先运行 --setup"}

    result = sso_login(username, encrypted_password, config.server_url)
    if result["success"]:
        # Store the token for future use
        config.set_token(result["token"])
    return result

def refresh_token():
    """Force refresh token by re-login"""
    from config import config

    username, encrypted_password = config.get_credentials()
    if not username or not encrypted_password:
        return {"success": False, "error": "未配置用户凭证，请先运行 --setup"}

    result = sso_login(username, encrypted_password, config.server_url)
    if result["success"]:
        config.set_token(result["token"])
    return result
