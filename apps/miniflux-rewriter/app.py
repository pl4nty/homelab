import os
import json
import logging
import requests
import yaml
import hmac
import hashlib
from flask import Flask, request, jsonify
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)
app = Flask(__name__)

MINIFLUX_API_URL = os.environ.get('MINIFLUX_API_URL', 'http://miniflux/v1')
MINIFLUX_API_KEY = os.environ.get('MINIFLUX_API_KEY')
WEBHOOK_SECRET = os.environ.get('WEBHOOK_SECRET')

RULES_FILE = 'data/rules.yaml'
RULES_CONFIG = {}

openai_client = None

def load_rules():
    """Load rules configuration from YAML file."""
    global RULES_CONFIG
    try:
        if os.path.exists(RULES_FILE):
            with open(RULES_FILE, 'r') as file:
                RULES_CONFIG = yaml.safe_load(file)
                logger.info(f"Loaded rules configuration from {RULES_FILE}")
                logger.info(f"Configured rules for feeds: {list(RULES_CONFIG.get('feed_rules', {}).keys())}")
        else:
            logger.warning(f"Rules file {RULES_FILE} not found. Using default empty configuration.")
    except Exception as e:
        logger.error(f"Error loading rules configuration: {str(e)}")

def generate_ai_summary(content, title):
    """Generate an AI summary of the content using OpenAI."""
    if not openai_client:
      openai_client = OpenAI()
    try:
        prompt = f"Summarize the following article titled '{title}' in 2-3 concise sentences:\n\n{content}"
        
        response = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": "You are a helpful assistant that summarizes articles."},
                {"role": "user", "content": prompt}
            ],
            max_tokens=150
        )
        
        summary = response.choices[0].message.content.strip()
        return f"<div class='ai-summary'><strong>AI Summary:</strong> {summary}</div><hr/>"
    except Exception as e:
        logger.error(f"Error generating AI summary: {str(e)}")
        return ""

def apply_rules(entry, rules_to_apply):
    """Apply the specified rules to an entry."""
    modified_entry = entry.copy()
    
    for rule in rules_to_apply:
        if rule == "ai_summary":
            summary = generate_ai_summary(entry["content"], entry["title"])
            if summary:
                modified_entry["content"] = f"{summary}{entry['content']}"
        
        # Add more rule implementations here as needed
    
    return modified_entry

def update_miniflux_entry(entry_id, updated_data):
    """Update an entry in Miniflux using the API."""
    url = f"{MINIFLUX_API_URL}/entries/{entry_id}"
    headers = {"X-Auth-Token": MINIFLUX_API_KEY}
    
    try:
        response = requests.put(url, json=updated_data, headers=headers)
        response.raise_for_status()
        return True
    except requests.exceptions.RequestException as e:
        logger.error(f"Error updating entry {entry_id}: {str(e)}")
        return False

def is_valid_signature(payload, signature):
    """Validate the webhook signature using HMAC-SHA256."""
    if not WEBHOOK_SECRET:
        logger.warning("WEBHOOK_SECRET not set, skipping signature validation")
        return False
    
    computed_signature = hmac.new(
        WEBHOOK_SECRET.encode(), 
        payload.encode(), 
        hashlib.sha256
    ).hexdigest()
    
    return hmac.compare_digest(computed_signature, signature)

@app.route('/', methods=['POST'])
def webhook():
    signature = request.headers.get('X-Miniflux-Signature')
    if not signature:
        logger.warning("Unauthorized access attempt - missing signature header")
        return jsonify({"error": "Unauthorized: Missing signature"}), 401
    
    payload = request.get_data(as_text=True)
    if not payload:
        return jsonify({"error": "Invalid request, empty payload"}), 400
    
    if not is_valid_signature(payload, signature):
        logger.warning("Unauthorized access attempt - invalid signature")
        return jsonify({"error": "Unauthorized: Invalid signature"}), 401
    
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return jsonify({"error": "Invalid JSON payload"}), 400
    
    logger.info(f"Received webhook: {data.get('event_type')} for feed ID {data.get('feed', {}).get('id')}")
    
    if data.get("event_type") != "new_entries":
        return jsonify({"status": "ignored", "reason": "Not a new_entries event"}), 200
    
    feed_id = str(data.get("feed", {}).get("id"))
    if feed_id not in RULES_CONFIG.get("feed_rules", {}):
        return jsonify({"status": "ignored", "reason": "No rules for this feed"}), 200
    
    rules_to_apply = RULES_CONFIG["feed_rules"][feed_id]
    entries = data.get("entries", [])
    for entry in entries:
        entry_id = entry.get("id")
        modified_entry = apply_rules(entry, rules_to_apply)
        
        if modified_entry != entry:
            update_miniflux_entry(entry_id, {
                "title": modified_entry.get("title"),
                "content": modified_entry.get("content")
            })
    
    return jsonify({"status": "success"}), 200

if __name__ == "__main__":
    if not MINIFLUX_API_KEY:
        logger.warning("MINIFLUX_API_KEY not set. Webhook won't be able to update entries.")
    
    if not WEBHOOK_SECRET:
        logger.warning("WEBHOOK_SECRET not set. Payloads will be accepted from anywhere! You probably don't want this.")

    load_rules()
    app.run(host="0.0.0.0", port=8080)