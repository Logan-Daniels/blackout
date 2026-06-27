import re
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# Set your YouTube Data API v3 Key here
with open('../keys/youtube.txt', 'r', encoding='utf-8') as file:
    # Read the full file content into a string variable
    API_KEY = file.read()

def extract_video_id(url):
    """
    Extracts the 11-character video ID from various YouTube URL formats.
    """
    pattern = r'(?:https?://)?(?:www\.)?(?:youtube\.com/(?:[^/]+/.+/|(?:v|e(?:mbed)?)|watch\?.*v=)|youtu\.be/)([^"&?/\s]{11})'
    match = re.search(pattern, url)
    return match.group(1) if match else None

def check_video_status(video_url):
    video_id = extract_video_id(video_url)
    if not video_id:
        print("Invalid YouTube URL.")
        return

    try:
        # Initialize the YouTube API client
        youtube = build('youtube', 'v3', developerKey=API_KEY)
        
        # Request contentDetails (for region restrictions) and status (for embeddable flag)
        request = youtube.videos().list(
            part="contentDetails,status,snippet",
            id=video_id
        )
        response = request.execute()

        if not response['items']:
            print("Video not found. It might be private or deleted.")
            return

        video_data = response['items'][0]
        title = video_data['snippet']['title']
        content_details = video_data['contentDetails']
        status = video_data['status']

        print(f"## Analysis for: '{title}' ({video_id})\n" + "-"*40)

        # 1. Test if Embeds are allowed on other websites
        embeddable = status.get('embeddable', False)
        if embeddable:
            print("✅ Embed Status: Allowed. This video can be embedded on external websites.")
        else:
            print("❌ Embed Status: Blocked. The creator has disabled external website embedding.")

        # 2. Figure out Country / Region restrictions
        region_restriction = content_details.get('regionRestriction', {})
        
        allowed_countries = region_restriction.get('allowed', [])
        blocked_countries = region_restriction.get('blocked', [])

        print("\n### Region Restrictions:")
        if not allowed_countries and not blocked_countries:
            print("🌍 Global Availability: This video is NOT blocked in any country.")
        elif allowed_countries:
            print(f"🏳️ Whitelist active: This video is ONLY viewable in the following country codes:\n   {', '.join(allowed_countries)}")
            print("   (It is blocked everywhere else).")
        elif blocked_countries:
            print(f"🚫 Blacklist active: This video is BLOCKED in the following country codes:\n   {', '.join(blocked_countries)}")
            print("   (It is available everywhere else).")

    except HttpError as e:
        print(f"An API error occurred: {e}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

if __name__ == "__main__":
    # Replace with any YouTube link you want to test
    test_url = "https://www.youtube.com/watch?v=Fc_7RQ_CsF4"
    check_video_status(test_url)