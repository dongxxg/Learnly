#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import json

class Config:
    def __init__(self):
        self.config_file = os.path.join(os.path.dirname(__file__), ".devops_config.json")
        self.server_url = "http://192.168.118.247:2011"

    def get_credentials(self):
        """Get username and encrypted password from config"""
        if not os.path.exists(self.config_file):
            return None, None

        try:
            with open(self.config_file, 'r') as f:
                data = json.load(f)
                return data.get("username"), data.get("encrypted_password")
        except:
            return None, None

    def set_credentials(self, username, plain_password):
        """Set credentials with encrypted password (preserves existing fields like token)"""
        from sso_login import encrypt_password
        encrypted = encrypt_password(plain_password)

        data = {}
        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, 'r') as f:
                    data = json.load(f)
            except:
                pass

        data["username"] = username
        data["encrypted_password"] = encrypted

        with open(self.config_file, 'w') as f:
            json.dump(data, f, indent=2)

    def clear_credentials(self):
        """Clear stored credentials"""
        if os.path.exists(self.config_file):
            os.remove(self.config_file)

    def validate_config(self):
        """Check if config is valid"""
        username, password = self.get_credentials()
        return username is not None and password is not None

    def get_token(self):
        """Get stored token"""
        if not os.path.exists(self.config_file):
            return None
        try:
            with open(self.config_file, 'r') as f:
                data = json.load(f)
                return data.get("token")
        except:
            return None

    def set_token(self, token):
        """Store token in config"""
        data = {}
        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, 'r') as f:
                    data = json.load(f)
            except:
                pass

        data["token"] = token
        with open(self.config_file, 'w') as f:
            json.dump(data, f, indent=2)

config = Config()
