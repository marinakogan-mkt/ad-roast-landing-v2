// Notion database: AdRoast Leads
const NOTION_DATABASE_ID = '90888e98cd794663acaf9f94ba7bd494';

// Generate short ID (8 chars)
const generateId = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) {
    console.error('NOTION_API_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const { email, linkedin, platform, adScore, lpScore, matchScore, roastData, icp } = req.body;
    
    const reportId = generateId();
    const linkedinUsername = linkedin?.split('/in/')?.[1]?.replace(/\/$/, '') || 'Unknown';
    const reportLink = `https://koganmarina.com/?id=${reportId}`;
    
    const platformMap = {
      'meta': 'Meta',
      'linkedin': 'LinkedIn', 
      'google': 'Google',
      'twitter': 'X/Twitter'
    };

    const properties = {
      'Lead': { title: [{ text: { content: linkedinUsername } }] },
      'Report ID': { rich_text: [{ text: { content: reportId } }] },
      'Report Link': { url: reportLink },
      'Date': { date: { start: new Date().toISOString().split('T')[0] } }
    };

    if (email) properties['Email'] = { email: email };
    if (linkedin) properties['LinkedIn'] = { url: linkedin.startsWith('http') ? linkedin : `https://${linkedin}` };
    if (platform && platformMap[platform]) properties['Platform'] = { select: { name: platformMap[platform] } };
    if (adScore && adScore !== 'N/A') properties['Ad Score'] = { number: parseFloat(adScore) };
    if (lpScore && lpScore !== 'N/A') properties['LP Score'] = { number: parseFloat(lpScore) };
    if (matchScore && matchScore !== 'N/A') properties['Match Score'] = { number: parseFloat(matchScore) };

    // Build readable content blocks
    const children = [];
    
    // Hidden JSON block for retrieval (first block)
    const roastJson = JSON.stringify({ result: roastData, icp, platform });
    const chunks = [];
    for (let i = 0; i < roastJson.length; i += 2000) {
      chunks.push(roastJson.substring(i, i + 2000));
    }
    chunks.forEach(chunk => {
      children.push({
        object: 'block',
        type: 'code',
        code: {
          rich_text: [{ type: 'text', text: { content: chunk } }],
          language: 'json'
        }
      });
    });

    // Divider
    children.push({ object: 'block', type: 'divider', divider: {} });

    // Readable summary
    if (roastData) {
      // ICP
      children.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: '🎯 Target Audience' } }] }
      });
      children.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: icp || 'Not specified' } }] }
      });

      // Verdict
      children.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: '🔥 Ad Verdict' } }] }
      });
      children.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: roastData.icp_mismatch || 'N/A' } }] }
      });

      // Scores
      children.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: '📊 Scores' } }] }
      });
      children.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: `Ad Score: ${roastData.overall_score || 'N/A'}/10` } }] }
      });
      children.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: `Landing Page: ${roastData.landing_page_roast?.overall_score || 'N/A'}/10` } }] }
      });
      children.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: `Ad-LP Match: ${roastData.ad_landing_mismatch?.alignment_score || 'N/A'}/10` } }] }
      });

      // Fix Kit Headlines
      if (roastData.fix_kit?.headlines) {
        children.push({
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ type: 'text', text: { content: '✏️ Suggested Headlines' } }] }
        });
        roastData.fix_kit.headlines.forEach(h => {
          children.push({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: [{ type: 'text', text: { content: h } }] }
          });
        });
      }

      // Fix Kit CTAs
      if (roastData.fix_kit?.ctas) {
        children.push({
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ type: 'text', text: { content: '🔘 Suggested CTAs' } }] }
        });
        roastData.fix_kit.ctas.forEach(c => {
          children.push({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: [{ type: 'text', text: { content: c } }] }
          });
        });
      }
    }

    console.log('[Lead API] Saving to Notion:', { reportId, linkedinUsername, blocks: children.length });

    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: properties,
        children: children
      })
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error('[Lead API] Notion error:', JSON.stringify(responseData));
      return res.status(500).json({ error: 'Failed to save', details: responseData });
    }

    console.log('[Lead API] Success:', reportId);
    return res.status(200).json({ success: true, reportId });
  } catch (error) {
    console.error('[Lead API] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
