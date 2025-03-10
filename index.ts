import axios from 'axios';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import moment from 'moment';
import dotenv from 'dotenv';

dotenv.config();

const JIRA_URL = process.env.JIRA_URL || '';
const JIRA_USERNAME = process.env.JIRA_USERNAME || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';
const JIRA_PROJECT = process.env.JIRA_PROJECT || '';
const OUTPUT_FILE = 'Jira_Issues_Report.pdf';

// Define colors for better design
const COLORS = {
  primary: '#0052CC', // Jira blue
  secondary: '#253858', // Dark blue
  text: '#172B4D', // Dark text
  lightGray: '#F4F5F7', // Background
  border: '#DFE1E6', // Border color
  link: '#0065FF', // Link color
  epic: '#6554C0', // Epic color
  story: '#36B37E', // Story color
  task: '#4BADE8', // Task color
  bug: '#FF5630', // Bug color
  error: '#DE350B', // Error/warning color
  inProgress: '#0052CC', // In Progress color
  
  // Status colors
  statusBacklog: '#8993A4', // Gray for Backlog/Selected for Development
  statusInProgress: '#FFAB00', // Yellow for In Progress/In Review
  statusDone: '#36B37E', // Green for Ready/Production
};

// Define allowed issue types
const ALLOWED_ISSUE_TYPES = ['Epic', 'Story', 'Task', 'Bug'];

// Define development statuses (customize these based on your Jira workflow)
const DEV_STATUSES = ['In Progress', 'Development', 'In Development', 'Coding', 'Implementation'];

// Define status categories
const STATUS_CATEGORIES = {
  backlog: ['Backlog', 'Selected for Development', 'To Do', 'Open', 'New'],
  inProgress: ['In Progress', 'In Review', 'Development', 'Testing', 'In Development', 'Coding', 'Implementation', 'Review'],
  done: ['Ready', 'Production', 'Done', 'Closed', 'Resolved', 'Complete', 'Released', "Deployed"]
};

// Function to determine status category
function getStatusCategory(status: string): 'backlog' | 'inProgress' | 'done' {
  status = status.toLowerCase();
  
  for (const category of Object.keys(STATUS_CATEGORIES) as Array<keyof typeof STATUS_CATEGORIES>) {
    if (STATUS_CATEGORIES[category].some(s => status.includes(s.toLowerCase()))) {
      return category;
    }
  }
  
  // Default to backlog if unknown
  return 'backlog';
}

// Function to get status color
function getStatusColor(status: string): string {
  const category = getStatusCategory(status);
  
  switch (category) {
    case 'backlog': return COLORS.statusBacklog;
    case 'inProgress': return COLORS.statusInProgress;
    case 'done': return COLORS.statusDone;
    default: return COLORS.statusBacklog;
  }
}

async function fetchJiraIssues(inDevelopmentOnly = false) {
  try {
    console.log("Fetching issues from Jira...");
    
    // Build JQL query
    let jql = `project = ${JIRA_PROJECT} AND issuetype in (Epic, Story, Task, Bug)`;
    
    // Add status filter for development issues
    if (inDevelopmentOnly) {
      const oneWeekAgo = moment().subtract(1, 'week').format('YYYY-MM-DD');
      jql += ` AND status in ("${DEV_STATUSES.join('", "')}")`;
      jql += ` AND (updated >= ${oneWeekAgo} OR created >= ${oneWeekAgo})`;
    } else {
      jql += ` AND duedate IS NOT EMPTY`;
    }
    
    console.log(`JQL Query: ${jql}`);
    
    const response = await axios.get(`${JIRA_URL}/rest/api/3/search`, {
      auth: {
        username: JIRA_USERNAME,
        password: JIRA_API_TOKEN
      },
      params: {
        jql: jql,
        fields: 'summary,duedate,assignee,description,issuetype,key,parent,epic,status,created,updated',
        maxResults: 100,
        expand: 'names'
      }
    });
    console.log(`Found ${response.data.issues.length} issues`);
    return response.data.issues;
  } catch (error) {
    console.error('Error fetching Jira issues:', error);
    return [];
  }
}

function groupIssuesByWeek(issues: any[]) {
  console.log(`Grouping ${issues.length} issues by week`);
  const result = issues.reduce((acc: Record<string, any[]>, issue: any) => {
    if (issue.fields.duedate) {
      const dueDate = moment(issue.fields.duedate);
      const weekStart = dueDate.startOf('isoWeek').format('YYYY-MM-DD');
      
      if (!acc[weekStart]) {
        acc[weekStart] = [];
      }
      acc[weekStart].push(issue);
    }
    return acc;
  }, {});
  
  console.log(`Grouped into ${Object.keys(result).length} weeks`);
  return result;
}

function groupIssuesByAssignee(issues: any[]) {
  return issues.reduce((acc: Record<string, any[]>, issue: any) => {
    const assignee = issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned';
    
    if (!acc[assignee]) {
      acc[assignee] = [];
    }
    acc[assignee].push(issue);
    return acc;
  }, {});
}

// Group issues by epic
function groupIssuesByEpic(issues: any[]) {
  // First, separate epics from other issues
  const epics: any[] = [];
  const nonEpics: any[] = [];
  
  issues.forEach(issue => {
    if (issue.fields.issuetype?.name === 'Epic') {
      epics.push(issue);
    } else {
      nonEpics.push(issue);
    }
  });
  
  // Create a map of epic keys to their issues
  const epicMap: Record<string, any[]> = {};
  
  // Initialize with empty arrays for each epic
  epics.forEach(epic => {
    epicMap[epic.key] = [epic]; // Start with the epic itself
  });
  
  // Add an "Unassigned to Epic" category
  epicMap['Unassigned'] = [];
  
  // Assign non-epic issues to their parent epics
  nonEpics.forEach(issue => {
    let epicKey = 'Unassigned';
    
    // Try to find the parent epic
    // Check for epic link field (different Jira configurations use different fields)
    if (issue.fields.parent && issue.fields.parent.key) {
      // Check if the parent is an epic in our list
      const parentKey = issue.fields.parent.key;
      if (epics.some(epic => epic.key === parentKey)) {
        epicKey = parentKey;
      }
    } else if (issue.fields.epic && issue.fields.epic.key) {
      epicKey = issue.fields.epic.key;
    }
    
    // Add to the appropriate epic group
    if (epicMap[epicKey]) {
      epicMap[epicKey].push(issue);
    } else {
      epicMap['Unassigned'].push(issue);
    }
  });
  
  return epicMap;
}

function formatWeekTitle(weekStart: string) {
  const start = moment(weekStart);
  const end = moment(weekStart).add(6, 'days');
  const weekNumber = start.isoWeek();
  return `Week ${weekNumber} (${start.format('DD-MM-YYYY')} to ${end.format('DD-MM-YYYY')})`;
}

// Function to get issue type color
function getIssueTypeColor(issueType: string): string {
  switch (issueType.toLowerCase()) {
    case 'epic': return COLORS.epic;
    case 'story': return COLORS.story;
    case 'task': return COLORS.task;
    case 'bug': return COLORS.bug;
    default: return COLORS.text;
  }
}

// Function to format description text (truncate if too long)
function formatDescription(description: any): string {
  if (!description) return 'No description provided.';
  
  // If description is in Atlassian Document Format (ADF)
  if (typeof description === 'object' && description.content) {
    let plainText = '';
    try {
      // Extract text from ADF content
      const extractText = (content: any[]): string => {
        if (!content || !Array.isArray(content)) return '';
        
        return content.map(item => {
          if (item.text) return item.text;
          if (item.content) return extractText(item.content);
          return '';
        }).join(' ');
      };
      
      plainText = extractText(description.content);
    } catch (e) {
      plainText = 'Error parsing description.';
    }
    
    // Truncate if too long
    return plainText.length > 200 ? plainText.substring(0, 200) + '...' : plainText;
  }
  
  // If description is a string
  if (typeof description === 'string') {
    return description.length > 200 ? description.substring(0, 200) + '...' : description;
  }
  
  return 'Description in unsupported format.';
}

// Add this function to filter weeks to only include recent ones
function filterRecentWeeks(issuesByWeek: Record<string, any[]>): Record<string, any[]> {
  const currentWeekStart = moment().startOf('isoWeek').format('YYYY-MM-DD');
  const lastWeekStart = moment().subtract(1, 'week').startOf('isoWeek').format('YYYY-MM-DD');
  const twoWeeksAgoStart = moment().subtract(2, 'weeks').startOf('isoWeek').format('YYYY-MM-DD');
  
  // Get all week keys
  const allWeeks = Object.keys(issuesByWeek).sort();
  
  // Filter to only include current week, last week, and two weeks ago
  const recentWeeks = allWeeks.filter(week => {
    return week === currentWeekStart || week === lastWeekStart || week === twoWeeksAgoStart;
  });
  
  // Create a new object with only the recent weeks
  const filteredIssues: Record<string, any[]> = {};
  recentWeeks.forEach(week => {
    filteredIssues[week] = issuesByWeek[week];
  });
  
  // If we have future weeks in the data, include those too
  allWeeks.forEach(week => {
    if (week > currentWeekStart) {
      filteredIssues[week] = issuesByWeek[week];
    }
  });
  
  return filteredIssues;
}

// Update the generatePDF function to use the filtered weeks
function generatePDF(issuesByWeek: Record<string, any[]>) {
  console.log("Generating PDF...");
  
  try {
    // Check if we have any data
    if (Object.keys(issuesByWeek).length === 0) {
      console.log("No issues found with due dates. Creating empty report.");
    }
    
    // Filter to only show recent weeks
    const recentIssuesByWeek = filterRecentWeeks(issuesByWeek);
    console.log(`Filtered to ${Object.keys(recentIssuesByWeek).length} recent weeks`);
    
    const doc = new PDFDocument({
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      size: 'A4'
    });
    
    const outputStream = fs.createWriteStream(OUTPUT_FILE);
    doc.pipe(outputStream);

    // Add header
    doc.fontSize(18).fillColor(COLORS.primary).text('Jira Issues Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor(COLORS.secondary).text(`Generated on ${moment().format('MMMM D, YYYY')}`, { align: 'center' });
    doc.fontSize(10).fillColor(COLORS.secondary).text(`Showing current week and previous 2 weeks`, { align: 'center' });
    doc.moveDown(1);

    // Add a horizontal line
    doc.strokeColor(COLORS.border).lineWidth(1).moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(1);
    
    // Add status legend
    addStatusLegend(doc);

    // If no issues, add a message
    if (Object.keys(recentIssuesByWeek).length === 0) {
      doc.fillColor(COLORS.text).fontSize(12).text('No issues found for recent weeks.', { align: 'center' });
      doc.moveDown(1);
    } else {
      // Process each week
      Object.keys(recentIssuesByWeek).sort().forEach(weekStart => {
        const weekTitle = formatWeekTitle(weekStart);
        console.log(`Processing week: ${weekTitle}`);
        
        // Highlight current week
        const isCurrentWeek = weekStart === moment().startOf('isoWeek').format('YYYY-MM-DD');
        
        // Week header
        doc.fillColor(isCurrentWeek ? COLORS.primary : COLORS.secondary).fontSize(14)
          .text(weekTitle + (isCurrentWeek ? ' (Current Week)' : ''), { underline: true });
        doc.moveDown(0.5);
        
        // Group issues by assignee within this week
        const issuesByAssignee = groupIssuesByAssignee(recentIssuesByWeek[weekStart]);
        
        // Process each assignee group
        Object.keys(issuesByAssignee).sort().forEach(assignee => {
          console.log(`  Processing assignee: ${assignee} (${issuesByAssignee[assignee].length} issues)`);
          
          // Assignee header
          doc.fillColor(COLORS.secondary).fontSize(12).text(`${assignee}`);
          doc.moveDown(0.3);
          
          // Group issues by epic for this assignee
          const issuesByEpic = groupIssuesByEpic(issuesByAssignee[assignee]);
          
          // Process each epic group
          Object.keys(issuesByEpic).forEach(epicKey => {
            const epicIssues = issuesByEpic[epicKey];
            
            if (epicIssues.length === 0) return; // Skip empty epics
            
            // If this is a real epic (not "Unassigned"), add the epic header
            if (epicKey !== 'Unassigned') {
              // Find the epic issue
              const epicIssue = epicIssues[0]; // The first issue should be the epic itself
              
              if (epicIssue.fields.issuetype?.name === 'Epic') {
                // Epic header
                doc.fillColor(COLORS.epic).fontSize(11)
                  .text(`Epic: ${epicIssue.fields.summary}`, {
                    link: `${JIRA_URL}/browse/${epicIssue.key}`,
                    underline: true
                  });
                doc.moveDown(0.2);
                
                // Process non-epic issues in this epic
                epicIssues.slice(1).forEach(issue => {
                  renderIssue(doc, issue);
                });
              }
            } else {
              // Handle unassigned issues
              // doc.fillColor(COLORS.secondary).fontSize(11)
              //   .text('Issues not assigned to any Epic:');
              // doc.moveDown(0.2);
              
              epicIssues.forEach(issue => {
                renderIssue(doc, issue);
              });
            }
            
            doc.moveDown(0.5);
          });
          
          doc.moveDown(0.5);
        });
        
        // Add a separator between weeks
        doc.moveDown(0.5);
        doc.strokeColor(COLORS.border).lineWidth(0.5).moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
        doc.moveDown(1);
      });
    }

    // Add simple footer
    // doc.fontSize(8).fillColor(COLORS.secondary).text(
    //   `Page 1`,
    //   { align: 'center' }
    // );

    // Finalize the PDF and end the stream
    doc.end();
    
    // Wait for the PDF to be fully written
    outputStream.on('finish', () => {
      console.log(`PDF generated: ${OUTPUT_FILE}`);
    });
    
    outputStream.on('error', (err) => {
      console.error('Error writing PDF:', err);
    });
  } catch (error) {
    console.error('Error generating PDF:', error);
  }
}

// Helper function to draw a status dot
function drawStatusDot(doc: PDFKit.PDFDocument, x: number, y: number, color: string, size = 6) {
  doc.circle(x, y, size / 2)
     .fillAndStroke(color, color);
  return doc;
}

// Add this function to check if an issue is delayed
function isDelayed(issue: any): boolean {
  if (!issue.fields.duedate) return false;
  
  const dueDate = moment(issue.fields.duedate);
  const today = moment();
  
  // Check if due date has passed
  if (dueDate.isBefore(today, 'day')) {
    // Check if the issue is not in a "done" status
    const status = issue.fields.status?.name || '';
    const statusCategory = getStatusCategory(status);
    return statusCategory !== 'done';
  }
  
  return false;
}

// Update the renderIssue function to show delayed status
function renderIssue(doc: PDFKit.PDFDocument, issue: any) {
  const dueDate = issue.fields.duedate ? moment(issue.fields.duedate).format('DD-MM-YYYY') : 'No due date';
  const summary = issue.fields.summary || 'No summary';
  const issueKey = issue.key || '';
  const issueType = issue.fields.issuetype?.name || 'Unknown';
  const issueLink = `${JIRA_URL}/browse/${issueKey}`;
  const description = formatDescription(issue.fields.description);
  const hasDescription = issue.fields.description ? true : false;
  const status = issue.fields.status?.name || 'Unknown Status';
  const isInDevelopment = DEV_STATUSES.includes(status);
  const updated = issue.fields.updated ? moment(issue.fields.updated).format('DD-MM-YYYY') : 'Unknown';
  const statusColor = getStatusColor(status);
  const delayed = isDelayed(issue);
  
  // Save current y position
  const startY = doc.y;
  
  // Draw status dot
  drawStatusDot(doc, 45, startY + 5, statusColor);
  
  // Issue type and key with link
  doc.fillColor(getIssueTypeColor(issueType)).fontSize(10)
    .text(`[${issueType}] ${issueKey}`, { 
      link: issueLink,
      underline: true,
      continued: false,
      indent: 10
    });
  
  // Summary with delayed indicator if needed
  if (delayed) {
    doc.fillColor(COLORS.text).fontSize(10)
      .text(`• ${summary} `, { indent: 10, continued: true });
    
    doc.fillColor(COLORS.error).fontSize(10)
      .text(`(DELAYED)`, { continued: false });
  } else {
    doc.fillColor(COLORS.text).fontSize(10)
      .text(`• ${summary}`, { indent: 10 });
  }
  
  // Status with color highlight for in-development items
  doc.fillColor(isInDevelopment ? COLORS.inProgress : COLORS.secondary).fontSize(9)
    .text(`  Status: ${status} (Updated: ${updated})`, { indent: 20 });
  
  // Description - use red color for "No description provided"
  doc.fillColor(hasDescription ? COLORS.text : COLORS.error).fontSize(9)
    .text(`  ${description}`, { 
      indent: 20,
      width: doc.page.width - 130,
      align: 'left'
    });

  // Due date - highlight in red if delayed
  doc.fillColor(delayed ? COLORS.error : COLORS.secondary).fontSize(6)
    .text(`   Due: ${dueDate}${delayed ? ' (Overdue)' : ''}`, { indent: 20 });
  
  doc.moveDown(0.5);
}

// Update the legend in both report functions
function addStatusLegend(doc: PDFKit.PDFDocument) {
  doc.fontSize(10).fillColor(COLORS.secondary).text('Status Legend:', { continued: false });
  doc.moveDown(0.3);
  
  const legendY = doc.y;
  
  // Backlog
  drawStatusDot(doc, 60, legendY + 4, COLORS.statusBacklog);
  doc.fillColor(COLORS.text).fontSize(9).text('Backlog / Selected for Development', { indent: 20 });
  
  // In Progress
  drawStatusDot(doc, 60, legendY + 14, COLORS.statusInProgress);
  doc.fillColor(COLORS.text).fontSize(9).text('In Progress / In Review', { indent: 20 });
  
  // Done
  drawStatusDot(doc, 60, legendY + 24, COLORS.statusDone);
  doc.fillColor(COLORS.text).fontSize(9).text('Ready / Production', { indent: 20 });
  
  // Delayed
  doc.fillColor(COLORS.error).fontSize(9).text('(DELAYED)', { indent: 20, continued: true });
  doc.fillColor(COLORS.text).fontSize(9).text(' - Issue is past due date but not completed', { continued: false });
  
  doc.moveDown(1);
}

// New function to generate a development status report
async function generateDevStatusReport() {
  console.log("Generating development status report...");
  
  // Fetch issues in development from the last week
  const issues = await fetchJiraIssues(true);
  
  if (issues.length === 0) {
    console.log("No issues in development found for the last week.");
    return;
  }
  
  // Group by assignee
  const issuesByAssignee = groupIssuesByAssignee(issues);
  
  // Create PDF
  const doc = new PDFDocument({
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    size: 'A4'
  });
  
  const outputStream = fs.createWriteStream('Jira_Development_Report.pdf');
  doc.pipe(outputStream);
  
  // Add header
  doc.fontSize(18).fillColor(COLORS.primary).text('Jira Development Status Report', { align: 'center' });
  doc.moveDown(0.5);
  
  const lastWeekDate = moment().subtract(1, 'week').format('MMMM D, YYYY');
  doc.fontSize(10).fillColor(COLORS.secondary)
    .text(`Issues in development since ${lastWeekDate}`, { align: 'center' });
  doc.fontSize(10).fillColor(COLORS.secondary)
    .text(`Generated on ${moment().format('MMMM D, YYYY')}`, { align: 'center' });
  doc.moveDown(1);
  
  // Add a horizontal line
  doc.strokeColor(COLORS.border).lineWidth(1).moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
  doc.moveDown(1);
  
  // Add status legend
  addStatusLegend(doc);
  
  // Process each assignee group
  Object.keys(issuesByAssignee).sort().forEach(assignee => {
    console.log(`  Processing assignee: ${assignee} (${issuesByAssignee[assignee].length} issues)`);
    
    // Assignee header
    doc.fillColor(COLORS.secondary).fontSize(12).text(`Assignee: ${assignee}`);
    doc.moveDown(0.3);
    
    // Group issues by epic for this assignee
    const issuesByEpic = groupIssuesByEpic(issuesByAssignee[assignee]);
    
    // Process each epic group
    Object.keys(issuesByEpic).forEach(epicKey => {
      const epicIssues = issuesByEpic[epicKey];
      
      if (epicIssues.length === 0) return; // Skip empty epics
      
      // If this is a real epic (not "Unassigned"), add the epic header
      if (epicKey !== 'Unassigned') {
        // Find the epic issue
        const epicIssue = epicIssues[0]; // The first issue should be the epic itself
        
        if (epicIssue.fields.issuetype?.name === 'Epic') {
          // Get epic status color
          const epicStatus = epicIssue.fields.status?.name || 'Unknown Status';
          const epicStatusColor = getStatusColor(epicStatus);
          
          // Epic header with status dot
          const epicY = doc.y;
          drawStatusDot(doc, 45, epicY + 5, epicStatusColor);
          
          doc.fillColor(COLORS.epic).fontSize(11)
            .text(`Epic: ${epicIssue.fields.summary}`, {
              link: `${JIRA_URL}/browse/${epicIssue.key}`,
              underline: true,
              indent: 10
            });
          doc.moveDown(0.2);
          
          // Process non-epic issues in this epic
          epicIssues.slice(1).forEach(issue => {
            renderIssue(doc, issue);
          });
        }
      } else {
        // Handle unassigned issues
        doc.fillColor(COLORS.secondary).fontSize(11)
          .text('Issues not assigned to any Epic:', { indent: 10 });
        doc.moveDown(0.2);
        
        epicIssues.forEach(issue => {
          renderIssue(doc, issue);
        });
      }
      
      doc.moveDown(0.5);
    });
    
    doc.moveDown(0.5);
  });
  
  // Add simple footer
  doc.fontSize(8).fillColor(COLORS.secondary).text(
    `Page 1`,
    { align: 'center' }
  );
  
  // Finalize the PDF and end the stream
  doc.end();
  
  // Wait for the PDF to be fully written
  outputStream.on('finish', () => {
    console.log(`Development status report generated: Jira_Development_Report.pdf`);
  });
}

// Main function
(async function () {
  console.log("Starting application...");
  
  try {
    // Check if we have Jira credentials
    if (!JIRA_URL || !JIRA_USERNAME || !JIRA_API_TOKEN || !JIRA_PROJECT) {
      console.log("Missing Jira credentials.");
      return;
    }
    
    // Generate development status report
    await generateDevStatusReport();
    
    // Generate the regular report with recent weeks
    const issues = await fetchJiraIssues();
    if (issues.length > 0) {
      const issuesByWeek = groupIssuesByWeek(issues);
      generatePDF(issuesByWeek);
    }
  } catch (error) {
    console.error("Error in main function:", error);
  }
  
  console.log("TypeScript with ESM is working!");
})();

export {};
